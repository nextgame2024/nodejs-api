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
    const published = await publicForms.getPublicForm(token);
    expect(published.blocks[2].calendar.advisorId).toBeUndefined();
    expect(published.businessName).toBe("Example company");
    await expect(
      publicForms.getPublicForm(otherTenant + "." + token.split(".")[1]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      publicForms.publishForm(advisor, company, form.id, {
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  test("filters form hours, creates one lead and booking on retry, and exposes responses only to its company", async () => {
    const state = await slots();
    expect(state.slots).toHaveLength(11); // 09:00 through 11:30, quarter-hour starts.
    const body = response(state.slots[0]);
    const [first, retry] = await Promise.all([
      publicForms.submitPublicForm(token, body),
      publicForms.submitPublicForm(token, body),
    ]);
    expect(first).toEqual(retry);
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
  test("draft edits do not affect published forms, republishing invalidates stale versions, and unpublish revokes the URL", async () => {
    form = await forms.saveForm(owner, company, form.id, {
      expectedVersion: form.version,
      form: { name: "New title", typeId: form.typeId, blocks: form.blocks },
    });
    expect((await publicForms.getPublicForm(token)).name).toBe("Discovery");
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
    await expect(publicForms.getPublicForm(token)).rejects.toMatchObject({
      status: 404,
    });
  });
  test('accepts marketing responses without a calendar and retains answers after the form is removed',async()=>{
    const standalone={id:randomUUID(),kind:'input',text:'Anything else?',required:false,options:[]};
    const draft=await forms.saveForm(owner,company,randomUUID(),{expectedVersion:0,form:{name:'Marketing campaign',typeId:form.typeId,blocks:[standalone]}});
    const published=await publicForms.publishForm(owner,company,draft.id,{expectedVersion:1});
    const result=await publicForms.submitPublicForm(published.token,{requestKey:randomUUID(),formVersion:1,contact:{name:'Campaign lead',email:'campaign@example.test'},answers:{[standalone.id]:'Interested in AI'}});
    expect(result.appointment).toBeNull();
    await forms.deleteForm(owner,company,draft.id,{expectedVersion:1});
    await expect(publicForms.getPublicForm(published.token)).rejects.toMatchObject({status:404});
    expect((await pool.query('SELECT answers FROM sophia_runtime.lead_form_submissions WHERE id=$1',[result.receipt])).rows[0].answers[0].value).toBe('Interested in AI');
  });

});
