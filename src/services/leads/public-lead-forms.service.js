import { preparationConfigs } from "../scheduling/meeting-preparation.js";
import { randomUUID } from "node:crypto";
import pool from "../../config/db.js";
import {
  formsTransaction,
  publicationsInstalled,
  requirePublications,
  requireFormEmailSetup,
} from "./lead-forms.service.js";
import { directory } from "./assistant-settings.service.js";
import { fail } from "./assistant-settings.contracts.js";
import {
  uuid,
  version,
  text,
  hash,
  leadInput,
} from "./lead-records.contracts.js";
import { formInput, formEmails } from "./lead-forms.contracts.js";
import {
  date,
  zone,
  bookingInput,
  calendarInput,
} from "../scheduling/lead-appointments.contracts.js";
import {
  authorizedAvailability,
  bookAuthorizedAppointment,
} from "../scheduling/lead-appointments.service.js";
import { filterFormSlots } from "./lead-form-bookings.service.js";
const s = "sophia_runtime";
export function publicToken(token) {
  token =
    Object.values(preparationConfigs())
      .flatMap((p) => [p, ...(p.aliases ?? [])])
      .find((p) => p.slug === token)?.publicToken ?? token;
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2) throw fail("Form not found.", 404);
  try {
    return { tenant: uuid(parts[0]), id: uuid(parts[1]) };
  } catch {
    throw fail("Form not found.", 404);
  }
}
async function publication(db, tenant, id) {
  await requirePublications(db);
  const p = (
    await db.query(
      `SELECT p.* FROM ${s}.lead_form_publications p JOIN ${s}.customers c ON c.customer_id=p.customer_id WHERE p.customer_id=$1 AND p.id=$2 AND p.active AND c.status='active' FOR SHARE OF p`,
      [tenant, id],
    )
  ).rows[0];
  if (!p) throw fail("This form is no longer available.", 404);
  return p;
}
async function publicRun(token, fn) {
  const { tenant, id } = publicToken(token),
    db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE sophia_runtime_app");
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenant]);
    const p = await publication(db, tenant, id);
    const result = await fn(db, tenant, p);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
async function team(db, tenant) {
  const release = (
    await db.query(
      `SELECT release_id,configuration FROM ${s}.lead_assistant_setting_releases WHERE customer_id=$1 ORDER BY source_revision DESC LIMIT 1`,
      [tenant],
    )
  ).rows[0];
  if (!release) throw fail("This form is not accepting responses yet.", 409);
  return release;
}
async function advisorAvailable(db, tenant, id, configuration) {
  if (!(configuration.advisorIds ?? []).includes(id))
    throw fail(
      "The calendar is unavailable. Please contact the business.",
      409,
    );
  // Identity directory read via the existing verified tenant -> company mapping.
  const company = (
    await db.query(
      `SELECT external_company_id FROM ${s}.customers WHERE customer_id=$1`,
      [tenant],
    )
  ).rows[0]?.external_company_id;
  if (!company || !(await directory(db, company, { ids: [id] })).length)
    throw fail(
      "The calendar is unavailable. Please contact the business.",
      409,
    );
}
export async function publishForm(actor, company, id, input) {
  uuid(id);
  const expected = version(input?.expectedVersion);
  return formsTransaction(
    actor,
    company,
    (db, tenant) => publishFormInTransaction(db, tenant, actor, id, expected),
    true,
  );
}
export async function publishFormInTransaction(
  db,
  tenant,
  actor,
  id,
  expected,
) {
  await requirePublications(db);
  await requireFormEmailSetup(db);
  const row = (
    await db.query(
      `SELECT * FROM ${s}.lead_forms WHERE customer_id=$1 AND id=$2 FOR UPDATE`,
      [tenant, id],
    )
  ).rows[0];
  if (!row || row.version !== expected)
    throw fail("This form changed. Reload it before publishing.", 409);
  const emails = formEmails(row.emails, true);
  const f = formInput({
    name: row.name,
    typeId: row.type_id,
    blocks: row.blocks,
  });
  const release = await team(db, tenant);
  if (f.blocks.filter((b) => b.kind === "calendar").length > 1)
    throw fail("Use one booking calendar per published form.");
  for (const b of f.blocks.filter((b) => b.kind === "calendar")) {
    await advisorAvailable(
      db,
      tenant,
      b.calendar.advisorId,
      release.configuration,
    );
    const c = (
      await db.query(
        `SELECT 1 FROM ${s}.lead_advisor_calendars WHERE customer_id=$1 AND advisor_identity=$2`,
        [tenant, b.calendar.advisorId],
      )
    ).rows[0];
    if (!c) {
      const hours = [];
      for (const h of [...b.calendar.weeklyHours].sort(
        (a, b) => a.day - b.day || a.start.localeCompare(b.start),
      )) {
        const last = hours.at(-1);
        if (last && last.day === h.day && last.end === h.start)
          last.end = h.end;
        else hours.push({ ...h });
      }
      if (hours.length > 28)
        throw fail(
          "Configure the advisor’s availability in Scheduling: this form has more than 28 separate working periods.",
          409,
        );
      const normalized = calendarInput({
        expectedRevision: 0,
        timezone: b.calendar.timezone,
        slotMinutes: 30,
        leadTimeMinutes: 60,
        bookingWindowDays: 30,
        weeklyHours: hours,
        closedDates: [],
      });
      const created = await db.query(
        `INSERT INTO ${s}.lead_advisor_calendars(customer_id,advisor_identity,timezone,slot_minutes,lead_time_minutes,booking_window_days,weekly_hours,closed_dates,updated_by_identity) VALUES($1,$2,$3,30,60,30,$4::jsonb,'[]'::jsonb,$5) ON CONFLICT DO NOTHING RETURNING revision`,
        [
          tenant,
          b.calendar.advisorId,
          b.calendar.timezone,
          JSON.stringify(normalized.weeklyHours),
          actor,
        ],
      );
      if (created.rowCount)
        await db.query(
          `INSERT INTO ${s}.lead_calendar_audit(customer_id,advisor_identity,revision,actor_identity,configuration) VALUES($1,$2,$3,$4,$5::jsonb)`,
          [
            tenant,
            b.calendar.advisorId,
            created.rows[0].revision,
            actor,
            JSON.stringify({
              timezone: b.calendar.timezone,
              slotMinutes: 30,
              leadTimeMinutes: 60,
              bookingWindowDays: 30,
              weeklyHours: normalized.weeklyHours,
              closedDates: [],
            }),
          ],
        );
    }
  }
  const old = (
    await db.query(
      `SELECT id,form_version FROM ${s}.lead_form_publications WHERE customer_id=$1 AND form_id=$2 AND active`,
      [tenant, id],
    )
  ).rows[0];
  if (old?.form_version === expected) return { token: tenant + "." + old.id };
  // Publishing updates the existing campaign URL; requests lock the published snapshot while submitting.
  const published = old
    ? (
        await db.query(
          `UPDATE ${s}.lead_form_publications SET form_version=$3,name=$4,blocks=$5::jsonb,business_name=$6,published_by_identity=$7,created_at=now() WHERE customer_id=$1 AND id=$2 RETURNING id`,
          [
            tenant,
            old.id,
            expected,
            f.name,
            JSON.stringify(f.blocks),
            release.configuration.businessName ?? "",
            actor,
          ],
        )
      ).rows[0]
    : (
        await db.query(
          `INSERT INTO ${s}.lead_form_publications(customer_id,form_id,form_version,name,blocks,business_name,published_by_identity) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
          [
            tenant,
            id,
            expected,
            f.name,
            JSON.stringify(f.blocks),
            release.configuration.businessName ?? "",
            actor,
          ],
        )
      ).rows[0];
  await db.query(
    `UPDATE ${s}.lead_form_publications SET emails=$3 WHERE customer_id=$1 AND id=$2`,
    [tenant, published.id, emails],
  );
  await db.query(
    `INSERT INTO ${s}.lead_forms_audit(customer_id,actor_identity,entity_id,action) VALUES($1,$2,$3,'form_published')`,
    [tenant, actor, id],
  );
  return { token: tenant + "." + published.id };
}

export async function publicationStatus(actor, company, id) {
  uuid(id);
  return formsTransaction(actor, company, async (db, tenant) => {
    if (!(await publicationsInstalled(db)))
      return { token: null, version: null };
    const row = (
      await db.query(
        `SELECT id,form_version FROM ${s}.lead_form_publications WHERE customer_id=$1 AND form_id=$2 AND active`,
        [tenant, id],
      )
    ).rows[0];
    return {
      token: row ? tenant + "." + row.id : null,
      version: row?.form_version ?? null,
    };
  });
}
export async function unpublishForm(actor, company, id) {
  uuid(id);
  return formsTransaction(
    actor,
    company,
    async (db, tenant) => {
      await requirePublications(db);
      const removed = await db.query(
        `UPDATE ${s}.lead_form_publications SET active=false WHERE customer_id=$1 AND form_id=$2 AND active`,
        [tenant, id],
      );
      if (removed.rowCount)
        await db.query(
          `INSERT INTO ${s}.lead_forms_audit(customer_id,actor_identity,entity_id,action) VALUES($1,$2,$3,'form_unpublished')`,
          [tenant, actor, id],
        );
      return { unpublished: true };
    },
    true,
  );
}
export async function getPublicForm(token) {
  return publicRun(token, async (db, tenant, p) => ({
    name: p.name,
    businessName: p.business_name,
    version: p.form_version,
    blocks: p.blocks.map((b) =>
      b.calendar
        ? {
            ...b,
            calendar: {
              timezone: b.calendar.timezone,
              weeklyHours: b.calendar.weeklyHours,
            },
          }
        : b,
    ),
  }));
}
export async function publicSlots(token, blockId, q) {
  const day = date(q.date),
    timezone = zone(q.timezone);
  uuid(blockId);
  return publicRun(token, async (db, tenant, p) => {
    if (Number(q.formVersion) !== p.form_version)
      throw fail("This form changed. Reload the page.", 409);
    const b = p.blocks.find((b) => b.id === blockId && b.kind === "calendar");
    if (!b) throw fail("Calendar not found.", 404);
    const release = await team(db, tenant);
    await advisorAvailable(
      db,
      tenant,
      b.calendar.advisorId,
      release.configuration,
    );
    const result = await authorizedAvailability(
      db,
      tenant,
      b.calendar.advisorId,
      day,
      timezone,
    );
    return { ...result, slots: filterFormSlots(b.calendar, result.slots) };
  });
}
export function richAnswerText(value) {
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|ensp|emsp|thinsp|ZeroWidthSpace);/gi, " ")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code) => {
      const n =
        code[0].toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : Number(code);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
}
export function submissionAnswers(blocks, input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Buffer.byteLength(JSON.stringify(input)) > 180000
  )
    throw fail("Check your form answers.");
  const answerBlocks = blocks.filter((b) =>
    ["input", "list", "checkboxes", "richtext"].includes(b.kind),
  );
  if (Object.keys(input).some((id) => !answerBlocks.some((b) => b.id === id)))
    throw fail("The form contains unknown answers.");
  const answers = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!["input", "list", "checkboxes", "richtext"].includes(b.kind)) continue;
    const question = blocks[i - 1]?.kind === "question" ? blocks[i - 1] : null;
    const raw = input[b.id];
    let value;
    if (b.kind === "checkboxes") {
      value = raw ?? [];
      if (
        !Array.isArray(value) ||
        value.length > 50 ||
        value.some((v) => !b.options.includes(v)) ||
        new Set(value).size !== value.length
      )
        throw fail("Select valid checkbox options.", 400, [b.id]);
    } else {
      value = text(
        raw ?? "",
        b.id,
        b.kind === "richtext" ? 20000 : b.kind === "input" ? 4000 : 200,
      );
      if (b.kind === "list" && value && !b.options.includes(value))
        throw fail("Select a valid list option.", 400, [b.id]);
    }
    if (
      question?.required &&
      !(b.kind === "richtext" ? richAnswerText(value).length : value.length)
    )
      throw fail("Complete the required questions.", 400, [b.id]);
    answers.push({
      id: b.id,
      ...(b.kind === "richtext" ? { format: "html" } : {}),
      label:
        question?.text || b.text || (b.kind === "input" ? "Input" : "Options"),
      value,
    });
  }
  if (Buffer.byteLength(JSON.stringify(answers)) > 180000)
    throw fail("Your response is too large. Shorten the text answers.");
  return answers;
}
export function businessEmailRecipient(answers) {
  // Use the builder's business-email question, never unrelated free-text answers.
  const candidates = answers.filter((a) =>
    /\bbusiness\s+e[ -]?mail\b/i.test(a.label),
  );
  if (candidates.length !== 1) return null;
  const value = candidates[0].value;
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value.trim())
  )
    return null;
  return value.trim().toLowerCase();
}
export async function submitPublicForm(token, input) {
  const key = uuid(input?.requestKey);
  if (input?.website) throw fail("The response could not be accepted.");
  const contact = leadInput({
    displayName: input?.contact?.name || "Form response",
    email: input?.contact?.email,
    phone: input?.contact?.phone ?? "",
    language: "en",
  });
  return publicRun(token, async (db, tenant, p) => {
    const fingerprint = hash({
      version: input.formVersion,
      contact,
      answers: input.answers,
      appointment: input.appointment ?? null,
    });
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      tenant + ":form:" + p.id + ":" + key,
    ]);
    const old = (
      await db.query(
        `SELECT request_hash,result FROM ${s}.lead_form_submissions WHERE customer_id=$1 AND publication_id=$2 AND request_key=$3`,
        [tenant, p.id, key],
      )
    ).rows[0];
    if (old) {
      if (old.request_hash !== fingerprint)
        throw fail(
          "This response was already submitted with different details.",
          409,
        );
      return old.result;
    }
    if (input.formVersion !== p.form_version)
      throw fail("This form changed. Reload the page before submitting.", 409);
    const answers = submissionAnswers(p.blocks, input.answers);
    const release = await team(db, tenant);
    const calendar = p.blocks.find((b) => b.kind === "calendar");
    if (calendar && !input.appointment)
      throw fail("Select an appointment time.", 400, [calendar.id]);
    if (!calendar && input.appointment)
      throw fail("This form has no booking calendar.");
    if (calendar)
      await advisorAvailable(
        db,
        tenant,
        calendar.calendar.advisorId,
        release.configuration,
      );
    const leadId = randomUUID(),
      actor = "public-form:" + p.id;
    const assignee =
      calendar?.calendar.advisorId ??
      release.configuration.enquiryOwnerId ??
      release.configuration.fallbackOwnerId ??
      null;
    await db.query(
      `INSERT INTO ${s}.assistant_leads(customer_id,lead_id,display_name,email,phone,language,interest,assigned_to_identity,settings_release_id,request_key,request_hash,created_by_identity,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'form')`,
      [
        tenant,
        leadId,
        contact.displayName,
        contact.email,
        contact.phone,
        release.configuration.defaultLanguage ?? "en",
        p.name,
        assignee,
        release.release_id,
        randomUUID(),
        fingerprint,
        actor,
      ],
    );
    const conversation = (
      await db.query(
        `INSERT INTO ${s}.assistant_lead_conversations(customer_id,lead_id) VALUES($1,$2) RETURNING conversation_id`,
        [tenant, leadId],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,actor_identity,kind,body,metadata) VALUES($1,$2,$3,'lead_created',$4,$5::jsonb)`,
      [
        tenant,
        conversation.conversation_id,
        actor,
        "Public form: " + p.name,
        JSON.stringify({
          source: "form",
          formId: p.form_id,
          publicationId: p.id,
        }),
      ],
    );
    let appointment = null;
    if (calendar) {
      const b = bookingInput(
        {
          requestKey: randomUUID(),
          leadId,
          advisorId: calendar.calendar.advisorId,
          startsAt: input.appointment.startsAt,
          timezone: calendar.calendar.timezone,
          calendarRevision: input.appointment.calendarRevision,
          description: "Public form: " + p.name,
        },
        "book",
      );
      const booked = await bookAuthorizedAppointment(
        db,
        tenant,
        actor,
        { stage: "new" },
        b,
        {
          origin: "public_lead_form",
          slotFilter: (slots) => filterFormSlots(calendar.calendar, slots),
        },
      );
      appointment = {
        startsAt: booked.appointment.startsAt,
        endsAt: booked.appointment.endsAt,
        timezone: calendar.calendar.timezone,
      };
    }
    const id = randomUUID(),
      result = {
        receipt: id,
        message: "Thank you! Your response has been received.",
        appointment,
        formName: p.name,
      };
    await db.query(
      `INSERT INTO ${s}.lead_form_submissions(customer_id,id,publication_id,lead_id,request_key,request_hash,answers,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [
        tenant,
        id,
        p.id,
        leadId,
        key,
        fingerprint,
        JSON.stringify(answers),
        JSON.stringify(result),
      ],
    );
    const customerEmail = businessEmailRecipient(answers);
    const recipients = new Set(
      p.emails
        ? formEmails(p.emails, true)
            .split(", ")
            .map((email) => email.toLowerCase())
        : [],
    );
    const deliveries = [...recipients].map((recipient) => ({
      recipient,
      payload: {
        formName: p.name,
        answers,
        appointment,
        ...(recipient === customerEmail ? { includeConfirmation: true } : {}),
      },
    }));
    if (customerEmail && !recipients.has(customerEmail))
      deliveries.push({
        recipient: customerEmail,
        payload: { formName: p.name, appointment, confirmationOnly: true },
      });
    for (const { recipient, payload } of deliveries)
      await db.query(
        `INSERT INTO ${s}.lead_form_email_outbox(customer_id,submission_id,recipient,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
        [tenant, id, recipient, JSON.stringify(payload)],
      );
    const summary = answers
      .map(
        (a) =>
          a.label +
          ": " +
          (Array.isArray(a.value)
            ? a.value.join(", ")
            : a.format === "html"
              ? richAnswerText(a.value)
              : a.value),
      )
      .join("\n");
    await db.query(
      `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,actor_identity,kind,body,metadata) VALUES($1,$2,$3,'note',$4,$5::jsonb)`,
      [
        tenant,
        conversation.conversation_id,
        actor,
        summary.slice(0, 3900) || "Form response received.",
        JSON.stringify({ submissionId: id, formId: p.form_id }),
      ],
    );
    return result;
  });
}
export async function leadSubmissions(actor, company, leadId) {
  uuid(leadId);
  return formsTransaction(actor, company, async (db, tenant, access) => {
    const { requiredLead } = await import("./lead-records.service.js");
    await requiredLead(db, tenant, access, leadId);
    return {
      items: (
        await db.query(
          `SELECT id,answers,result->>'formName' AS "formName",created_at AS "createdAt" FROM ${s}.lead_form_submissions WHERE customer_id=$1 AND lead_id=$2 ORDER BY created_at DESC LIMIT 100`,
          [tenant, leadId],
        )
      ).rows,
    };
  });
}
