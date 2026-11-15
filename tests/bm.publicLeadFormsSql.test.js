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
const adminUrl = process.env.LOCAL_PUBLIC_FORMS_ADMIN_URL;
const databaseName = "codex_public_forms_" + randomUUID().replaceAll("-", "");
const parsed = new URL(adminUrl ?? "postgresql://localhost:1/postgres");
parsed.pathname = "/" + databaseName;
const url = adminUrl ? parsed.toString() : null;
const admin = new Pool({
  connectionString: adminUrl ?? "postgresql://localhost:1/postgres",
});
let created = false;
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
const forms = await import("../src/services/leads/lead-forms.service.js");
const publicForms = await import(
  "../src/services/leads/public-lead-forms.service.js"
);
suite("Public forms and appointments on isolated PostgreSQL", () => {
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS;END IF;END $$;
   CREATE SCHEMA sophia_runtime;GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
   CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,status text,type text,name text);
   CREATE TABLE public.bm_company(company_id uuid PRIMARY KEY,status text);
   CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
   CREATE TABLE sophia_runtime.admin_memberships(customer_id uuid,identity_user_id text,status text,role_key text);
   CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,status text,pack_id text,role_key text);
   CREATE TABLE sophia_runtime.platform_operator_assignments(identity_user_id text,operator_company_id uuid,status text);
   GRANT SELECT ON sophia_runtime.customers,sophia_runtime.admin_memberships,sophia_runtime.business_pack_entitlements,sophia_runtime.platform_operator_assignments TO sophia_runtime_app;
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
      "131_lead_forms.sql",
      "132_public_lead_forms.sql",
      "133_lead_form_email_notifications.sql",
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
  afterAll(async () => {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });
  let form, token, calendarBlock, questionBlock, answerBlock;
  const nextDate = () =>
    new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const slots = () =>
    publicForms.publicSlots(token, calendarBlock.id, {
      date: nextDate(),
      timezone: "Australia/Brisbane",
      formVersion: form.version,
    });
  const response = (slot, key = randomUUID()) => ({
    requestKey: key,
    formVersion: form.version,
    contact: {
      name: "New customer",
      email: "customer@example.test",
      phone: "",
    },
    answers: { [answerBlock.id]: "Education" },
    appointment: { startsAt: slot.startsAt, calendarRevision: 1 },
  });
  test("validates required rich-text answers and preserves their display format", () => {
    const blocks = [
      { id: "q", kind: "question", text: "Goals?", required: true },
      { id: "a", kind: "richtext", text: "", options: [] },
    ];
    for (const value of [
      "<p><br></p>",
      "<p>&nbsp;</p>",
      "<script>fake answer</script>",
    ])
      expect(() =>
        publicForms.submissionAnswers(blocks, { a: value }),
      ).toThrow();
    expect(
      publicForms.submissionAnswers(blocks, {
        a: "<p><b>Improve service</b></p>",
      })[0],
    ).toMatchObject({ format: "html", value: "<p><b>Improve service</b></p>" });
  });
  test("publishes a snapshot with a stable campaign URL and no advisor identity in public output", async () => {
    await settings.saveSettings(owner, company, {
      expectedRevision: 0,
      configuration: config(),
    });
    await settings.publishSettings(owner, company, { expectedRevision: 1 });
    await appointments.saveCalendar(owner, company, advisor, {
      expectedRevision: 0,
      timezone: "Australia/Brisbane",
      slotMinutes: 30,
      leadTimeMinutes: 0,
      bookingWindowDays: 180,
      weeklyHours: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: "08:00",
        end: "17:00",
      })),
      closedDates: [],
    });
    const type = (await forms.listTypes(owner, company)).items[0];
    questionBlock = {
      id: randomUUID(),
      kind: "question",
      text: "Business type?",
      required: true,
      options: [],
    };
    answerBlock = {
      id: randomUUID(),
      kind: "list",
      text: "",
      required: false,
      options: ["Education", "Other"],
    };
    calendarBlock = {
      id: randomUUID(),
      kind: "calendar",
      text: "",
      required: false,
      options: [],
      calendar: {
        advisorId: advisor,
        timezone: "Australia/Brisbane",
        weeklyHours: Array.from({ length: 7 }, (_, day) => ({
          day,
          start: "09:00",
          end: "12:00",
        })),
      },
    };
    form = await forms.saveForm(owner, company, randomUUID(), {
      expectedVersion: 0,
      form: {
        name: "Discovery",
        emails: "owner@example.test, second@example.test",
        typeId: type.id,
        blocks: [questionBlock, answerBlock, calendarBlock],
      },
    });
    token = (
      await publicForms.publishForm(owner, company, form.id, {
        expectedVersion: form.version,
      })
    ).token;
    expect(
      (
        await publicForms.publishForm(owner, company, form.id, {
          expectedVersion: form.version,
        })
      ).token,
    ).toBe(token);
    expect(
      (await forms.listForms(owner, company, {})).items.find(
        (row) => row.id === form.id,
      ),
    ).toMatchObject({
      publicationToken: token,
      publishedVersion: form.version,
    });
    const published = await publicForms.getPublicForm(token);
    expect(published.blocks[2].calendar.advisorId).toBeUndefined();
    expect(published.businessName).toBe("Example company");
    expect(published.emails).toBeUndefined();
    await expect(
      publicForms.getPublicForm(otherTenant + "." + token.split(".")[1]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      publicForms.publishForm(advisor, company, form.id, {
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("initializes missing advisor availability from form hours without overwriting existing calendars", async () => {
    const time = (m) =>
      String(Math.floor(m / 60)).padStart(2, "0") +
      ":" +
      String(m % 60).padStart(2, "0");
    const hours = Array.from({ length: 7 }, (_, day) =>
      Array.from({ length: 16 }, (_, i) => ({
        day,
        start: time(540 + i * 30),
        end: time(570 + i * 30),
      })),
    ).flat();
    const draft = await forms.saveForm(owner, company, randomUUID(), {
      expectedVersion: 0,
      form: {
        name: "New advisor form",
        typeId: form.typeId,
        emails: "owner@example.test",
        blocks: [
          {
            ...calendarBlock,
            id: randomUUID(),
            calendar: {
              ...calendarBlock.calendar,
              advisorId: second,
              weeklyHours: hours,
            },
          },
        ],
      },
    });
    const published = await publicForms.publishForm(owner, company, draft.id, {
      expectedVersion: 1,
    });
    const calendar = (
      await pool.query(
        "SELECT * FROM sophia_runtime.lead_advisor_calendars WHERE customer_id=$1 AND advisor_identity=$2",
        [tenant, second],
      )
    ).rows[0];
    expect(calendar.weekly_hours).toHaveLength(7);
    expect(calendar.slot_minutes).toBe(30);
    await forms.saveForm(owner, company, draft.id, {
      expectedVersion: 1,
      form: {
        name: "Updated public form",
        typeId: form.typeId,
        emails: "owner@example.test",
        blocks: draft.blocks,
      },
    });
    expect((await publicForms.getPublicForm(published.token)).name).toBe(
      "Updated public form",
    );
    expect(
      (
        await pool.query(
          "SELECT revision FROM sophia_runtime.lead_advisor_calendars WHERE customer_id=$1 AND advisor_identity=$2",
          [tenant, second],
        )
      ).rows[0].revision,
    ).toBe(1);
    await expect(
      forms.saveForm(owner, company, draft.id, {
        expectedVersion: 2,
        form: {
          name: "Invalid update",
          typeId: form.typeId,
          emails: "owner@example.test",
          blocks: [
            {
              ...draft.blocks[0],
              calendar: { ...draft.blocks[0].calendar, advisorId: outsider },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await publicForms.getPublicForm(published.token)).name).toBe(
      "Updated public form",
    );
    expect((await forms.getForm(owner, company, draft.id)).version).toBe(2);
    // Simulate calendars created by the old publisher without derived offsets.
    await pool.query(
      `UPDATE sophia_runtime.lead_advisor_calendars SET weekly_hours=(SELECT jsonb_agg(h-'startMinute'-'endMinute') FROM jsonb_array_elements(weekly_hours) h) WHERE customer_id=$1 AND advisor_identity=$2`,
      [tenant, second],
    );
    const availability = await publicForms.publicSlots(
      published.token,
      draft.blocks[0].id,
      { date: nextDate(), timezone: "Australia/Brisbane", formVersion: 2 },
    );
    expect(availability.slots.length).toBeGreaterThan(0);
    const submission = await publicForms.submitPublicForm(published.token, {
      requestKey: randomUUID(),
      formVersion: 2,
      answers: {},
      appointment: {
        blockId: draft.blocks[0].id,
        startsAt: availability.slots[0].startsAt,
        calendarRevision: availability.calendarRevision,
      },
    });
    expect(submission.appointment.startsAt).toBe(
      availability.slots[0].startsAt,
    );
  });
  test("filters form hours, creates one lead and booking on retry, and exposes responses only to its company", async () => {
    const state = await slots();
    expect(state.slots).toHaveLength(11); // 09:00 through 11:30, quarter-hour starts.
    const body = response(state.slots[0]);
    delete body.contact; // Only builder-defined answers are required.
    const [first, retry] = await Promise.all([
      publicForms.submitPublicForm(token, body),
      publicForms.submitPublicForm(token, body),
    ]);
    expect(first).toEqual(retry);
    expect(
      (
        await pool.query(
          "SELECT recipient FROM sophia_runtime.lead_form_email_outbox WHERE submission_id=$1",
          [first.receipt],
        )
      ).rows
        .map((r) => r.recipient)
        .sort(),
    ).toEqual(["owner@example.test", "second@example.test"]);
    expect(first.appointment.startsAt).toBe(state.slots[0].startsAt);
    const row = (
      await pool.query(
        "SELECT * FROM sophia_runtime.lead_form_submissions WHERE id=$1",
        [first.receipt],
      )
    ).rows[0];
    const lead = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_leads WHERE lead_id=$1",
        [row.lead_id],
      )
    ).rows[0];
    expect(lead.customer_id).toBe(tenant);
    expect(lead.source).toBe("form");
    expect(lead.display_name).toBe("Form response");
    expect(lead.email || "").toBe("");
    expect(lead.assigned_to_identity).toBe(advisor);
    expect(
      (await publicForms.leadSubmissions(owner, company, row.lead_id)).items[0]
        .answers[0].value,
    ).toBe("Education");
    await expect(
      publicForms.leadSubmissions(outsider, otherCompany, row.lead_id),
    ).rejects.toMatchObject({ status: 403 });
    const records = await appointments.listAppointments(owner, company, {
      start: nextDate(),
      end: nextDate(),
      timezone: "Australia/Brisbane",
    });
    expect(records.items.some((a) => a.leadId === row.lead_id)).toBe(true);
  });
  test("rejects occupied slots, outside-hours tampering and invalid answers without creating partial leads", async () => {
    const count = async () =>
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM sophia_runtime.assistant_leads",
          )
        ).rows[0].count,
      );
    const before = await count();
    const state = await slots();
    const occupied = (
      await pool.query(
        "SELECT starts_at FROM sophia_runtime.lead_appointments LIMIT 1",
      )
    ).rows[0].starts_at.toISOString();
    await expect(
      publicForms.submitPublicForm(token, response({ startsAt: occupied })),
    ).rejects.toMatchObject({ status: 409 });
    const outside = new Date(nextDate() + "T08:00:00+10:00").toISOString();
    await expect(
      publicForms.submitPublicForm(token, response({ startsAt: outside })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      publicForms.submitPublicForm(token, {
        ...response(state.slots[0]),
        answers: { [answerBlock.id]: "Invalid" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      publicForms.submitPublicForm(token, {
        ...response(state.slots[0]),
        answers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await count()).toBe(before);
  });
  test("concurrent customers cannot book the same slot", async () => {
    const state = await slots(),
      slot = state.slots[0];
    const outcomes = await Promise.allSettled([
      publicForms.submitPublicForm(token, response(slot)),
      publicForms.submitPublicForm(token, response(slot)),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
  });
  test("saving published forms updates the same URL, rejects stale versions, and unpublish revokes the URL", async () => {
    form = await forms.saveForm(owner, company, form.id, {
      expectedVersion: form.version,
      form: { name: "New title", typeId: form.typeId, blocks: form.blocks },
    });
    expect((await publicForms.getPublicForm(token)).name).toBe("New title");
    expect(
      (
        await publicForms.publishForm(owner, company, form.id, {
          expectedVersion: form.version,
        })
      ).token,
    ).toBe(token);
    await expect(
      publicForms.publicSlots(token, calendarBlock.id, {
        date: nextDate(),
        timezone: "Australia/Brisbane",
        formVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await publicForms.unpublishForm(owner, company, form.id);
    expect(
      (await forms.listForms(owner, company, {})).items.find(
        (row) => row.id === form.id,
      ).publicationToken,
    ).toBeNull();
    await expect(publicForms.getPublicForm(token)).rejects.toMatchObject({
      status: 404,
    });
  });
  test("accepts marketing responses without a calendar and retains answers after the form is removed", async () => {
    const standalone = {
      id: randomUUID(),
      kind: "input",
      text: "Anything else?",
      required: false,
      options: [],
    };
    const draft = await forms.saveForm(owner, company, randomUUID(), {
      expectedVersion: 0,
      form: {
        name: "Marketing campaign",
        emails: "marketing@example.test",
        typeId: form.typeId,
        blocks: [standalone],
      },
    });
    const published = await publicForms.publishForm(owner, company, draft.id, {
      expectedVersion: 1,
    });
    const result = await publicForms.submitPublicForm(published.token, {
      requestKey: randomUUID(),
      formVersion: 1,
      contact: { name: "Campaign lead", email: "campaign@example.test" },
      answers: { [standalone.id]: "Interested in AI" },
    });
    expect(result.appointment).toBeNull();
    await forms.deleteForm(owner, company, draft.id, { expectedVersion: 1 });
    await expect(
      publicForms.getPublicForm(published.token),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await pool.query(
          "SELECT answers FROM sophia_runtime.lead_form_submissions WHERE id=$1",
          [result.receipt],
        )
      ).rows[0].answers[0].value,
    ).toBe("Interested in AI");
  });
  test("queues a private customer confirmation once from the builder business email", async () => {
    const block = {
      id: randomUUID(),
      kind: "input",
      text: "What is your business email?",
      required: false,
      options: [],
    };
    const draft = await forms.saveForm(owner, company, randomUUID(), {
      expectedVersion: 0,
      form: {
        name: "Confirmation",
        emails: "owner@example.test",
        typeId: form.typeId,
        blocks: [block],
      },
    });
    const published = await publicForms.publishForm(owner, company, draft.id, {
      expectedVersion: 1,
    });
    const input = {
      requestKey: randomUUID(),
      formVersion: 1,
      answers: { [block.id]: "Customer@example.test" },
    };
    const result = await publicForms.submitPublicForm(published.token, input);
    await publicForms.submitPublicForm(published.token, input);
    const rows = (
      await pool.query(
        "SELECT recipient,payload FROM sophia_runtime.lead_form_email_outbox WHERE submission_id=$1",
        [result.receipt],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    const customer = rows.find((r) => r.recipient === "customer@example.test");
    expect(customer.payload.confirmationOnly).toBe(true);
    expect(customer.payload.answers).toBeUndefined();
    expect(
      rows.find((r) => r.recipient === "owner@example.test").payload.answers,
    ).toHaveLength(1);
  });
  test("queues each notification once and retries delivery without duplicating bookings", async () => {
    const { processFormEmail, formEmailMessage } = await import(
      "../src/services/leads/form-email.service.js"
    );
    const rows = (
      await pool.query("SELECT * FROM sophia_runtime.lead_form_email_outbox")
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(
      new Set(rows.map((r) => r.submission_id + ":" + r.recipient)).size,
    ).toBe(rows.length);
    const db = await pool.connect();
    const send = jest.fn().mockRejectedValueOnce(new Error("temporary"));
    try {
      expect(await processFormEmail(db, tenant, send)).toBe("retry");
      const target = send.mock.calls[0];
      await pool.query(
        "UPDATE sophia_runtime.lead_form_email_outbox SET available_at=now()-interval '1 minute' WHERE recipient=$1",
        [target[0]],
      );
      send.mockResolvedValue(undefined);
      expect(await processFormEmail(db, tenant, send)).toBe("sent");
      expect(await processFormEmail(db, otherTenant, send)).toBe("idle");
      const message = formEmailMessage({
        formName: "Test",
        contact: { email: "customer@example.test" },
        answers: [{ label: "Question", value: "<script>unsafe</script>" }],
        appointment: null,
      });
      expect(message.html).not.toContain("<script>");
      expect(message.html).toContain("Question");
    } finally {
      db.release();
    }
  });
  test("missing publication table keeps drafts readable and returns an actionable publishing error", async () => {
    await pool.query(
      "ALTER TABLE sophia_runtime.lead_form_publications RENAME TO lead_form_publications_pending",
    );
    try {
      const list = await forms.listForms(owner, company, {});
      expect(list.items.find((row) => row.id === form.id)).toMatchObject({
        publicationToken: null,
        publishedVersion: null,
      });
      expect(
        await publicForms.publicationStatus(owner, company, form.id),
      ).toEqual({ token: null, version: null });
      await expect(
        publicForms.publishForm(owner, company, form.id, {
          expectedVersion: form.version,
        }),
      ).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("database setup"),
      });
      await expect(
        publicForms.unpublishForm(owner, company, form.id),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await pool.query(
        "ALTER TABLE sophia_runtime.lead_form_publications_pending RENAME TO lead_form_publications",
      );
    }
  });
});
