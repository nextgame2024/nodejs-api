import { transaction, directory } from "../leads/assistant-settings.service.js";
import { requiredLead } from "../leads/lead-records.service.js";
import { fail } from "../leads/assistant-settings.contracts.js";
import { hash } from "../leads/lead-records.contracts.js";
import {
  date,
  zone,
  uuid,
  calendarInput,
  bookingInput,
  listInput,
} from "./lead-appointments.contracts.js";
import { localParts, filterSlots } from "./lead-appointments.slots.js";
const s = "sophia_runtime";
const fields = `a.appointment_id AS id,a.lead_id AS "leadId",l.display_name AS "leadName",a.advisor_identity AS "advisorId",a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.customer_timezone AS timezone,a.description,a.status,a.version,a.calendar_revision AS "calendarRevision"`;
const calendarFields = `advisor_identity AS "advisorId",timezone,slot_minutes AS "slotMinutes",lead_time_minutes AS "leadTimeMinutes",booking_window_days AS "bookingWindowDays",weekly_hours AS "weeklyHours",closed_dates AS "closedDates",revision`;
async function run(actor, company, fn) {
  return transaction(
    actor,
    company,
    async (db, tenant, access) => {
      if (
        !(
          await db.query(
            "SELECT to_regclass('sophia_runtime.lead_appointments') IS NOT NULL AS ready",
          )
        ).rows[0].ready
      )
        throw fail(
          "Lead appointments are not available yet. Ask your administrator to finish setup.",
          503,
        );
      return fn(db, tenant, access);
    },
    { inbox: true },
  );
}
async function advisors(db, company, access) {
  const ids = access.published?.configuration?.advisorIds ?? [];
  return ids.length ? directory(db, company, { ids }) : [];
}
async function requireAdvisor(db, company, access, id) {
  if (!(await advisors(db, company, access)).some((a) => a.id === id))
    throw fail(
      "Select an active advisor from the published enquiry team.",
      409,
      ["advisorId"],
    );
}
async function calendar(db, tenant, id, lock = false) {
  return (
    (
      await db.query(
        `SELECT ${calendarFields} FROM ${s}.lead_advisor_calendars WHERE customer_id=$1 AND advisor_identity=$2 ${lock ? "FOR UPDATE" : ""}`,
        [tenant, id],
      )
    ).rows[0] ?? null
  );
}
export async function schedulingContext(actor, company) {
  return run(actor, company, async (db, tenant, access) => ({
    actorId: actor,
    canManage: access.canManageLeads,
    advisors: await advisors(db, company, access),
    timezone: access.published?.configuration?.timezone ?? "Australia/Brisbane",
  }));
}
export async function bookingLead(actor, company, id) {
  id = uuid(id);
  return run(actor, company, async (db, tenant, access) => {
    const l = await requiredLead(db, tenant, access, id);
    return {
      lead: {
        leadId: l.lead_id,
        displayName: l.display_name,
        assignedTo: l.assigned_to_identity,
        stage: l.stage,
      },
    };
  });
}
export async function getCalendar(actor, company, id) {
  id = uuid(id);
  return run(actor, company, async (db, tenant, access) => {
    await requireAdvisor(db, company, access, id);
    return {
      calendar: await calendar(db, tenant, id),
      canEdit: access.canManageLeads || actor === id,
    };
  });
}
export async function saveCalendar(actor, company, id, input) {
  id = uuid(id);
  const c = calendarInput(input);
  return run(actor, company, async (db, tenant, access) => {
    if (!access.canManageLeads && actor !== id)
      throw fail("You can only change your own availability.", 403);
    await requireAdvisor(db, company, access, id);
    const args = [
      tenant,
      id,
      c.timezone,
      c.slotMinutes,
      c.leadTimeMinutes,
      c.bookingWindowDays,
      JSON.stringify(c.weeklyHours),
      JSON.stringify(c.closedDates),
      actor,
    ];
    const result =
      c.expectedRevision === 0
        ? await db.query(
            `INSERT INTO ${s}.lead_advisor_calendars(customer_id,advisor_identity,timezone,slot_minutes,lead_time_minutes,booking_window_days,weekly_hours,closed_dates,updated_by_identity) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) ON CONFLICT DO NOTHING RETURNING revision`,
            args,
          )
        : await db.query(
            `UPDATE ${s}.lead_advisor_calendars SET timezone=$3,slot_minutes=$4,lead_time_minutes=$5,booking_window_days=$6,weekly_hours=$7::jsonb,closed_dates=$8::jsonb,updated_by_identity=$9,updated_at=now(),revision=revision+1 WHERE customer_id=$1 AND advisor_identity=$2 AND revision=$10 RETURNING revision`,
            [...args, c.expectedRevision],
          );
    if (!result.rowCount)
      throw fail(
        "Availability changed in another session. Reload before saving.",
        409,
      );
    const saved = await calendar(db, tenant, id);
    await db.query(
      `INSERT INTO ${s}.lead_calendar_audit(customer_id,advisor_identity,revision,actor_identity,configuration) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [tenant, id, saved.revision, actor, JSON.stringify(saved)],
    );
    return { calendar: saved, canEdit: true };
  });
}
async function slots(db, tenant, c, day, timezone, exclude = null) {
  const row = (
    await db.query(
      `SELECT now() AS now,
 (SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) FROM (SELECT point AS "startsAt",point+($5::int*interval '1 minute') AS "endsAt" FROM generate_series($3::date::timestamp AT TIME ZONE $4,(($3::date+1)::timestamp AT TIME ZONE $4) - interval '1 second',interval '15 minutes') point)t) AS candidates,
 (SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) FROM (SELECT starts_at AS "startsAt",ends_at AS "endsAt" FROM ${s}.lead_appointments WHERE customer_id=$1 AND advisor_identity=$2 AND status='confirmed' AND ($6::uuid IS NULL OR appointment_id<>$6) AND tstzrange(starts_at,ends_at,'[)') && tstzrange($3::date::timestamp AT TIME ZONE $4,(($3::date+1)::timestamp AT TIME ZONE $4) + interval '1 hour','[)'))t) AS busy`,
      [tenant, c.advisorId, day, timezone, c.slotMinutes, exclude],
    )
  ).rows[0];
  return filterSlots(c, row.candidates, row.busy, row.now.toISOString());
}
export async function availability(actor, company, q) {
  const id = uuid(q.advisorId),
    day = date(q.date),
    timezone = zone(q.timezone),
    exclude = q.excludeId ? uuid(q.excludeId) : null;
  return run(actor, company, async (db, tenant, access) => {
    await requireAdvisor(db, company, access, id);
    if (exclude) {
      const old = (
        await db.query(
          `SELECT lead_id FROM ${s}.lead_appointments WHERE customer_id=$1 AND appointment_id=$2`,
          [tenant, exclude],
        )
      ).rows[0];
      if (!old) throw fail("Appointment not found.", 404);
      await requiredLead(db, tenant, access, old.lead_id);
    }
    const c = await calendar(db, tenant, id);
    return {
      calendarRevision: c?.revision ?? 0,
      timezone,
      advisorTimezone: c?.timezone ?? null,
      slots: c ? await slots(db, tenant, c, day, timezone, exclude) : [],
    };
  });
}
export async function listAppointments(actor, company, query) {
  const q = listInput(query);
  return run(actor, company, async (db, tenant, access) => {
    const args = [
      tenant,
      access.canManageLeads,
      actor,
      q.start,
      q.end,
      q.timezone,
      q.advisorId,
      q.leadId,
      q.status,
    ];
    const where = `a.customer_id=$1 AND ($2::boolean OR l.assigned_to_identity=$3) AND a.starts_at>=($4::date::timestamp AT TIME ZONE $6) AND a.starts_at<(($5::date+1)::timestamp AT TIME ZONE $6) AND ($7::text IS NULL OR a.advisor_identity=$7) AND($8::uuid IS NULL OR a.lead_id=$8) AND($9::text IS NULL OR a.status=$9)`;
    const sort = {
        startsAt: "a.starts_at",
        lead: "lower(l.display_name)",
        status: "a.status",
      }[q.sort],
      direction = q.direction === "desc" ? "DESC" : "ASC";
    const row = (
      await db.query(
        `SELECT (SELECT count(*)::int FROM ${s}.lead_appointments a JOIN ${s}.assistant_leads l USING(customer_id,lead_id) WHERE ${where}) AS total,(SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) FROM(SELECT ${fields} FROM ${s}.lead_appointments a JOIN ${s}.assistant_leads l USING(customer_id,lead_id) WHERE ${where} ORDER BY ${sort} ${direction},a.appointment_id ${direction} LIMIT $10 OFFSET $11)t) AS items`,
        [...args, q.limit, (q.page - 1) * q.limit],
      )
    ).rows[0];
    return { ...row, page: q.page, limit: q.limit };
  });
}
async function appointment(db, tenant, id) {
  return (
    await db.query(
      `SELECT ${fields} FROM ${s}.lead_appointments a JOIN ${s}.assistant_leads l USING(customer_id,lead_id) WHERE a.customer_id=$1 AND a.appointment_id=$2`,
      [tenant, id],
    )
  ).rows[0];
}
// Shared booking operations do not know about WhatsApp, AI vendors or external
// calendars. A future authorized tool adapter must use this same conflict path.
export async function mutateAppointment(actor, company, action, id, input) {
  if (!["book", "reschedule", "cancel"].includes(action))
    throw fail("Unsupported appointment action.");
  const b = bookingInput(input, action);
  if (action !== "book") id = uuid(id);
  return run(actor, company, async (db, tenant, access) => {
    const lead = await requiredLead(db, tenant, access, b.leadId, true);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      tenant + ":appointment:" + b.requestKey,
    ]);
    const fingerprint = hash({ action, id: id ?? null, ...b });
    const replay = (
      await db.query(
        `SELECT actor_identity,request_hash,result FROM ${s}.lead_appointment_mutations WHERE customer_id=$1 AND request_key=$2`,
        [tenant, b.requestKey],
      )
    ).rows[0];
    if (replay) {
      if (
        replay.actor_identity !== actor ||
        replay.request_hash !== fingerprint
      )
        throw fail(
          "This request was already used for different appointment details.",
          409,
        );
      return replay.result;
    }
    let existing;
    if (action !== "book") {
      existing = await appointment(db, tenant, id);
      if (!existing || existing.leadId !== b.leadId)
        throw fail("Appointment not found.", 404);
      if (existing.version !== b.expectedVersion)
        throw fail("This appointment changed. Refresh before saving.", 409);
      if (existing.status !== "confirmed")
        throw fail("This appointment is already cancelled.", 409);
      if (Date.parse(existing.startsAt) <= Date.now())
        throw fail("Past appointments are read-only.", 409);
    }
    let c, end;
    if (action !== "cancel") {
      if (lead.stage === "closed")
        throw fail("Reopen this lead before booking an appointment.", 409);
      await requireAdvisor(db, company, access, b.advisorId);
      // Rescheduling retains the advisor. Changing advisor is an explicit cancel
      // and new booking, avoiding multi-calendar lock inversions.
      if (existing && existing.advisorId !== b.advisorId)
        throw fail("Cancel and book again to change the advisor.", 409);
      c = await calendar(db, tenant, b.advisorId, true);
      if (!c || c.revision !== b.calendarRevision)
        throw fail("Availability changed. Choose a time again.", 409, ["slot"]);
      const selected = (
        await slots(
          db,
          tenant,
          c,
          localParts(b.startsAt, b.timezone).date,
          b.timezone,
          id,
        )
      ).find((slot) => slot.startsAt === b.startsAt);
      if (!selected)
        throw fail(
          "The selected time is no longer available. Choose another time.",
          409,
          ["slot"],
        );
      end = selected.endsAt;
    }
    let result;
    try {
      if (action === "book") {
        const saved = (
          await db.query(
            `INSERT INTO ${s}.lead_appointments(customer_id,lead_id,advisor_identity,starts_at,ends_at,customer_timezone,description,calendar_revision,created_by_identity,updated_by_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING appointment_id`,
            [
              tenant,
              b.leadId,
              b.advisorId,
              b.startsAt,
              end,
              b.timezone,
              b.description,
              c.revision,
              actor,
            ],
          )
        ).rows[0];
        id = saved.appointment_id;
      } else if (action === "cancel")
        await db.query(
          `UPDATE ${s}.lead_appointments SET status='cancelled',version=version+1,updated_by_identity=$3,updated_at=now() WHERE customer_id=$1 AND appointment_id=$2`,
          [tenant, id, actor],
        );
      else
        await db.query(
          `UPDATE ${s}.lead_appointments SET starts_at=$3,ends_at=$4,customer_timezone=$5,description=$6,calendar_revision=$7,version=version+1,updated_by_identity=$8,updated_at=now() WHERE customer_id=$1 AND appointment_id=$2`,
          [
            tenant,
            id,
            b.startsAt,
            end,
            b.timezone,
            b.description,
            c.revision,
            actor,
          ],
        );
    } catch (e) {
      if (e.code === "23P01")
        throw fail(
          "The selected time is no longer available. Choose another time.",
          409,
          ["slot"],
        );
      throw e;
    }
    result = JSON.parse(
      JSON.stringify({ appointment: await appointment(db, tenant, id) }),
    );
    await db.query(
      `INSERT INTO ${s}.lead_appointment_mutations(customer_id,request_key,actor_identity,request_hash,appointment_id,action,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        tenant,
        b.requestKey,
        actor,
        fingerprint,
        id,
        action,
        JSON.stringify(result),
      ],
    );
    const conversation = (
      await db.query(
        `SELECT conversation_id FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2`,
        [tenant, b.leadId],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,actor_identity,kind,body,metadata) VALUES($1,$2,$3,'note',$4,$5::jsonb)`,
      [
        tenant,
        conversation.conversation_id,
        actor,
        {
          book: "Appointment booked",
          reschedule: "Appointment rescheduled",
          cancel: "Appointment cancelled",
        }[action],
        JSON.stringify({
          origin: "scheduling",
          appointmentId: id,
          action,
          startsAt: result.appointment.startsAt,
          endsAt: result.appointment.endsAt,
          advisorId: result.appointment.advisorId,
        }),
      ],
    );
    await db.query(
      `UPDATE ${s}.assistant_leads SET updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
      [tenant, b.leadId],
    );
    return result;
  });
}
