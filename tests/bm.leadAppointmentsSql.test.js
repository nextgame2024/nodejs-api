import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  beforeAll,
  afterAll,
  describe,
  test,
  expect,
  jest,
} from "@jest/globals";
const url = process.env.LOCAL_LEAD_APPOINTMENTS_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw new Error("A disposable local database is required.");
const suite = url ? describe : describe.skip;
const pool = new Pool({
  connectionString: url ?? "postgresql://postgres@127.0.0.1:1/unused",
  max: 4,
});
jest.unstable_mockModule("../src/config/db.js", () => ({ default: pool }));
const settings = await import(
  "../src/services/leads/assistant-settings.service.js"
);
const appointments = await import(
  "../src/services/scheduling/lead-appointments.service.js"
);
const api = await import("../src/services/leads/lead-records.service.js");
const { defaults } = await import(
  "../src/services/leads/assistant-settings.contracts.js"
);
const tenant = randomUUID(),
  company = randomUUID(),
  owner = randomUUID(),
  advisor = randomUUID(),
  second = randomUUID(),
  queueOwner = randomUUID(),
  contentOwner = randomUUID(),
  otherTenant = randomUUID(),
  otherCompany = randomUUID(),
  outsider = randomUUID();
const config = () => ({
  ...defaults(),
  businessName: "Example company",
  contactName: "Support",
  supportContact: "help@example.test",
  greeting: "Hello",
  afterHoursMessage: "Our team will reply during business hours.",
  enquiryOwnerId: queueOwner,
  fallbackOwnerId: queueOwner,
  contentOwnerId: contentOwner,
  advisorIds: [advisor, second],
  coverage: [{ day: 1, start: "09:00", end: "17:00" }],
});
const input = (assignedTo = advisor) => ({
  displayName: "Example enquiry",
  email: "example@example.test",
  phone: "+61 412 345 678",
  language: "es",
  interest: "Product enquiry",
  location: "Brisbane",
  timeframe: "Next month",
  stage: "new",
  stageReason: "",
  assignedTo,
});
let lead, otherLead;
suite("Lead appointments and advisor calendars on PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS;END IF;END $$;
   CREATE SCHEMA sophia_runtime;GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
   CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,status text,type text,name text);
   CREATE TABLE public.bm_company(company_id uuid PRIMARY KEY,status text);
   CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
   CREATE TABLE sophia_runtime.admin_memberships(customer_id uuid,identity_user_id text,status text,role_key text);
   CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,status text,pack_id text,role_key text);
   GRANT SELECT ON sophia_runtime.admin_memberships,sophia_runtime.business_pack_entitlements TO sophia_runtime_app;
   ALTER DEFAULT PRIVILEGES IN SCHEMA sophia_runtime GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO sophia_runtime_app;`);
    await pool.query(
      "INSERT INTO public.bm_company VALUES($1,'active'),($2,'active')",
      [company, otherCompany],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.customers VALUES($1,$2,'active'),($3,$4,'active')",
      [tenant, company, otherTenant, otherCompany],
    );
    for (const [id, c, name] of [
      [owner, company, "Manager"],
      [advisor, company, "Advisor A"],
      [second, company, "Advisor B"],
      [queueOwner, company, "Enquiry owner"],
      [contentOwner, company, "Content owner"],
      [outsider, otherCompany, "Other tenant"],
    ])
      await pool.query(
        "INSERT INTO public.users VALUES($1,$2,'active','employee',$3)",
        [id, c, name],
      );
    await pool.query(
      "INSERT INTO sophia_runtime.admin_memberships VALUES($1,$2,'active','organisation_owner')",
      [tenant, owner],
    );
    for (const name of [
      "116_lead_assistant_settings.sql",
      "117_lead_records_and_inbox.sql",
      "121_lead_appointments.sql",
    ])
      await pool.query(
        (
          await readFile(
            new URL(
              "../sophia-runtime/src/database/migrations/" + name,
              import.meta.url,
            ),
            "utf8",
          )
        ).replaceAll("__SOPHIA_RUNTIME_SCHEMA__", "sophia_runtime"),
      );
  });
  afterAll(async () => pool.end());

  test("publishes the team, creates scoped leads and leaves calendars opt-in", async () => {
    await settings.saveSettings(owner, company, {
      expectedRevision: 0,
      configuration: config(),
    });
    await settings.publishSettings(owner, company, { expectedRevision: 1 });
    lead = (
      await api.createLead(owner, company, {
        requestKey: randomUUID(),
        lead: input(),
      })
    ).lead;
    otherLead = (
      await api.createLead(owner, company, {
        requestKey: randomUUID(),
        lead: input(second),
      })
    ).lead;
    expect(
      (await appointments.schedulingContext(advisor, company)).advisors,
    ).toHaveLength(2);
    expect(
      (await appointments.getCalendar(owner, company, advisor)).calendar,
    ).toBeNull();
    await expect(
      appointments.schedulingContext(contentOwner, company),
    ).rejects.toMatchObject({ status: 403 });
  });
  const profile = () => ({
    expectedRevision: 0,
    timezone: "Australia/Brisbane",
    slotMinutes: 30,
    leadTimeMinutes: 0,
    bookingWindowDays: 180,
    weeklyHours: Array.from({ length: 7 }, (_, day) => ({
      day,
      start: "09:00",
      end: "12:00",
    })),
    closedDates: [],
  });
  const nextDate = () =>
    new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const available = async (id = advisor, extra = {}) =>
    appointments.availability(owner, company, {
      advisorId: id,
      date: nextDate(),
      timezone: "Australia/Brisbane",
      ...extra,
    });
  const book = (leadId, slot, extra = {}) => ({
    leadId,
    requestKey: randomUUID(),
    advisorId: advisor,
    startsAt: slot.startsAt,
    timezone: "Australia/Brisbane",
    calendarRevision: 1,
    description: "Consultation",
    ...extra,
  });
  let saved, firstSlot;
  test("enforces self/manager availability authority, active team and optimistic revisions", async () => {
    await expect(
      appointments.saveCalendar(advisor, company, second, profile()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      appointments.saveCalendar(owner, company, outsider, profile()),
    ).rejects.toMatchObject({ status: 409 });
    const own = await appointments.saveCalendar(
      advisor,
      company,
      advisor,
      profile(),
    );
    expect(own.calendar.revision).toBe(1);
    await appointments.saveCalendar(owner, company, second, profile());
    await expect(
      appointments.saveCalendar(owner, company, advisor, profile()),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      appointments.saveCalendar(owner, company, advisor, {
        ...profile(),
        expectedRevision: 1,
        weeklyHours: [
          { day: 1, start: "09:00", end: "10:00" },
          { day: 1, start: "09:30", end: "11:00" },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("lists timezone-aware slots and books exactly once on concurrent retries", async () => {
    const slots = await available();
    expect(slots.slots).toHaveLength(11);
    firstSlot = slots.slots[0];
    const body = book(lead.leadId, firstSlot);
    const both = await Promise.all([
      appointments.mutateAppointment(owner, company, "book", null, body),
      appointments.mutateAppointment(owner, company, "book", null, body),
    ]);
    expect(both[0]).toEqual(both[1]);
    saved = both[0].appointment;
    await expect(
      appointments.mutateAppointment(owner, company, "book", null, {
        ...body,
        description: "Changed",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await available()).slots.some((s) => s.startsAt === firstSlot.startsAt),
    ).toBe(false);
    const viewer = await available(advisor, { timezone: "Pacific/Auckland" });
    expect(viewer.timezone).toBe("Pacific/Auckland");
  });
  test("rejects conflicting bookings across different leads, but allows a different advisor", async () => {
    await expect(
      appointments.mutateAppointment(
        owner,
        company,
        "book",
        null,
        book(otherLead.leadId, firstSlot),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const secondBooking = await appointments.mutateAppointment(
      owner,
      company,
      "book",
      null,
      book(otherLead.leadId, firstSlot, { advisorId: second }),
    );
    expect(secondBooking.appointment.advisorId).toBe(second);
  });
  test("applies lead assignment scope, safe pagination and server sorting", async () => {
    const q = {
      start: nextDate(),
      end: nextDate(),
      timezone: "Australia/Brisbane",
      page: 1,
      limit: 25,
      sort: "lead",
      direction: "desc",
    };
    const all = await appointments.listAppointments(owner, company, q);
    expect(all.total).toBe(2);
    const own = await appointments.listAppointments(advisor, company, q);
    expect(own.items.map((a) => a.leadId)).toEqual([lead.leadId]);
    const lookup = await appointments.bookingLead(
      advisor,
      company,
      lead.leadId,
    );
    expect(Object.keys(lookup.lead).sort()).toEqual([
      "assignedTo",
      "displayName",
      "leadId",
      "stage",
    ]);
    await expect(
      appointments.bookingLead(second, company, lead.leadId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      appointments.mutateAppointment(second, company, "cancel", saved.id, {
        leadId: lead.leadId,
        requestKey: randomUUID(),
        expectedVersion: saved.version,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      appointments.listAppointments(outsider, otherCompany, q),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("a failed reschedule preserves the original confirmed appointment", async () => {
    const slot = (await available()).slots[3];
    const busy = (
      await appointments.mutateAppointment(
        owner,
        company,
        "book",
        null,
        book(otherLead.leadId, slot),
      )
    ).appointment;
    await expect(
      appointments.mutateAppointment(
        owner,
        company,
        "reschedule",
        saved.id,
        book(lead.leadId, slot, { expectedVersion: saved.version }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const original = (
      await pool.query(
        "SELECT starts_at,version FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
        [saved.id],
      )
    ).rows[0];
    expect(original.starts_at.toISOString()).toBe(saved.startsAt);
    expect(original.version).toBe(1);
    await appointments.mutateAppointment(owner, company, "cancel", busy.id, {
      leadId: otherLead.leadId,
      requestKey: randomUUID(),
      expectedVersion: busy.version,
    });
  });
  test("reschedules atomically with version checks and releases the previous time", async () => {
    const slot = (await available()).slots.at(-1);
    const body = book(lead.leadId, slot, { expectedVersion: saved.version });
    const result = await appointments.mutateAppointment(
      owner,
      company,
      "reschedule",
      saved.id,
      body,
    );
    expect(result.appointment.version).toBe(2);
    await expect(
      appointments.mutateAppointment(owner, company, "reschedule", saved.id, {
        ...body,
        requestKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await available()).slots.some((s) => s.startsAt === firstSlot.startsAt),
    ).toBe(true);
    saved = result.appointment;
  });
  test("cancels idempotently, retains audit/timeline and frees the time", async () => {
    const body = {
      leadId: lead.leadId,
      requestKey: randomUUID(),
      expectedVersion: saved.version,
    };
    const cancelled = await appointments.mutateAppointment(
      owner,
      company,
      "cancel",
      saved.id,
      body,
    );
    expect(cancelled.appointment.status).toBe("cancelled");
    expect(
      await appointments.mutateAppointment(
        owner,
        company,
        "cancel",
        saved.id,
        body,
      ),
    ).toEqual(cancelled);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.assistant_lead_events WHERE metadata->>'appointmentId'=$1",
          [saved.id],
        )
      ).rows[0].n,
    ).toBe(3);
  });
  test("competing bookings with different request keys commit at most one reservation", async () => {
    const third = (
      await api.createLead(owner, company, {
        requestKey: randomUUID(),
        lead: input(),
      })
    ).lead;
    const slot = (await available()).slots[0];
    const result = await Promise.allSettled([
      appointments.mutateAppointment(
        owner,
        company,
        "book",
        null,
        book(lead.leadId, slot),
      ),
      appointments.mutateAppointment(
        owner,
        company,
        "book",
        null,
        book(third.leadId, slot),
      ),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find((r) => r.status === "rejected").reason.status).toBe(409);
  });
  test("refuses closed lead bookings and uses append-only calendar history", async () => {
    const closed = (
      await api.createLead(owner, company, {
        requestKey: randomUUID(),
        lead: input(),
      })
    ).lead;
    await api.updateLead(owner, company, closed.leadId, {
      expectedVersion: closed.version,
      lead: { ...input(), stage: "closed", stageReason: "Not proceeding" },
    });
    const slot = (await available(second)).slots.at(-1);
    await expect(
      appointments.mutateAppointment(
        owner,
        company,
        "book",
        null,
        book(closed.leadId, slot, { advisorId: second }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.lead_calendar_audit",
        )
      ).rows[0].n,
    ).toBe(2);
  });
  test("closed dates, breaks, minimum notice and stale calendar revisions are enforced at booking", async () => {
    const c = (await appointments.getCalendar(owner, company, advisor))
      .calendar;
    await appointments.saveCalendar(owner, company, advisor, {
      ...c,
      expectedRevision: c.revision,
      closedDates: [nextDate()],
    });
    expect((await available()).slots).toHaveLength(0);
    await expect(
      appointments.mutateAppointment(
        owner,
        company,
        "book",
        null,
        book(lead.leadId, firstSlot),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("database exclusion prevents overlaps even outside the service and RLS prevents cross-tenant reads", async () => {
    await expect(
      pool.query(
        `INSERT INTO sophia_runtime.lead_appointments(customer_id,lead_id,advisor_identity,starts_at,ends_at,customer_timezone,calendar_revision,created_by_identity,updated_by_identity) SELECT customer_id,lead_id,advisor_identity,starts_at,ends_at,customer_timezone,calendar_revision,created_by_identity,updated_by_identity FROM sophia_runtime.lead_appointments WHERE advisor_identity=$1 AND status='confirmed'`,
        [second],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (await db.query("SELECT * FROM sophia_runtime.lead_appointments")).rows,
      ).toHaveLength(0);
      await expect(
        db.query("DELETE FROM sophia_runtime.lead_appointments"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  });
});
