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
const url = process.env.LOCAL_LEAD_RECORDS_TEST_DATABASE_URL;
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
suite("Lead records and inbox on PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS;END IF;END $$;
   CREATE SCHEMA sophia_runtime;GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
   CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,status text,type text,name text);
   CREATE TABLE public.bm_company(company_id uuid PRIMARY KEY,status text);
   CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
   CREATE TABLE sophia_runtime.admin_memberships(customer_id uuid,identity_user_id text,status text,role_key text);
   CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,status text,pack_id text,role_key text);
   CREATE TABLE sophia_runtime.platform_operator_assignments(identity_user_id text,operator_company_id uuid,status text);
   GRANT SELECT ON sophia_runtime.admin_memberships,sophia_runtime.business_pack_entitlements,sophia_runtime.platform_operator_assignments TO sophia_runtime_app;
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
  test("requires published Settings for team access and lead creation", async () => {
    expect((await api.inboxContext(owner, company)).canCreate).toBe(false);
    await expect(api.inboxContext(advisor, company)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      api.createLead(owner, company, {
        requestKey: randomUUID(),
        lead: input(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await settings.saveSettings(owner, company, {
      expectedRevision: 0,
      configuration: config(),
    });
    await settings.publishSettings(owner, company, { expectedRevision: 1 });
    expect((await api.inboxContext(advisor, company)).defaultAssigneeId).toBe(
      advisor,
    );
    expect((await api.inboxContext(queueOwner, company)).canManageLeads).toBe(
      true,
    );
    await expect(api.inboxContext(contentOwner, company)).rejects.toMatchObject(
      { status: 403 },
    );
  });
  test("creates a manual lead exactly once on concurrent retry, with no student or contact creation", async () => {
    const key = randomUUID(),
      body = input();
    const results = await Promise.all([
      api.createLead(advisor, company, { requestKey: key, lead: body }),
      api.createLead(advisor, company, { requestKey: key, lead: body }),
    ]);
    lead = results[0].lead;
    expect(results[1].lead.leadId).toBe(lead.leadId);
    expect(lead.source).toBe("manual");
    expect(lead.ownership).toBe("paused");
    expect(
      (await pool.query("SELECT count(*)::int n FROM public.users")).rows[0].n,
    ).toBe(6);
    await expect(
      api.createLead(advisor, company, {
        requestKey: key,
        lead: { ...body, displayName: "Changed" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    otherLead = (
      await api.createLead(second, company, {
        requestKey: randomUUID(),
        lead: { ...input(second), displayName: "Second lead" },
      })
    ).lead;
  });
  test("enforces assigned-advisor access on list, details, events, notes and reassignment", async () => {
    expect(
      (await api.listLeads(advisor, company, {})).items.map((l) => l.leadId),
    ).toEqual([lead.leadId]);
    await expect(
      api.getLead(advisor, company, otherLead.leadId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      api.olderEvents(advisor, company, otherLead.leadId, null),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      api.addNote(advisor, company, otherLead.leadId, {
        requestKey: randomUUID(),
        body: "Not mine",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      api.updateLead(advisor, company, lead.leadId, {
        expectedVersion: 1,
        lead: input(second),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      api.getLead(outsider, otherCompany, lead.leadId),
    ).rejects.toMatchObject({ status: 403 });
    expect((await api.listLeads(queueOwner, company, {})).total).toBe(2);
  });
  test("keeps notes internal and idempotent while preserving text as data", async () => {
    const key = randomUUID(),
      body = "<script>alert(1)</script> Internal note";
    await api.addNote(advisor, company, lead.leadId, { requestKey: key, body });
    const repeated = await api.addNote(advisor, company, lead.leadId, {
      requestKey: key,
      body,
    });
    expect(repeated.events.filter((e) => e.kind === "note")).toHaveLength(1);
    expect(repeated.events.find((e) => e.kind === "note").body).toBe(body);
    await expect(
      api.addNote(advisor, company, lead.leadId, {
        requestKey: key,
        body: "Changed note",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("serializes ownership and invalidates it on assignment, preventing stale takeover", async () => {
    const claimed = await api.changeOwnership(advisor, company, lead.leadId, {
      expectedVersion: 1,
      ownership: "human",
    });
    expect(claimed.lead.humanOwner).toBe(advisor);
    const managerClaim = await api.changeOwnership(
      owner,
      company,
      lead.leadId,
      { expectedVersion: 2, ownership: "human" },
    );
    await expect(
      api.changeOwnership(advisor, company, lead.leadId, {
        expectedVersion: managerClaim.lead.ownershipVersion,
        ownership: "paused",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      api.changeOwnership(advisor, company, lead.leadId, {
        expectedVersion: 1,
        ownership: "paused",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const reassigned = await api.updateLead(owner, company, lead.leadId, {
      expectedVersion: 1,
      lead: input(second),
    });
    lead = reassigned.lead;
    expect(lead.ownership).toBe("paused");
    expect(lead.humanOwner).toBeNull();
    expect(lead.ownershipVersion).toBe(4);
    await expect(
      api.getLead(advisor, company, lead.leadId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      api.changeOwnership(second, company, lead.leadId, {
        expectedVersion: 3,
        ownership: "bot",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("prevents lost updates and requires reasons for Qualified/Closed stages", async () => {
    const writes = await Promise.allSettled([
      api.updateLead(second, company, lead.leadId, {
        expectedVersion: 2,
        lead: input(second),
      }),
      api.updateLead(second, company, lead.leadId, {
        expectedVersion: 2,
        lead: input(second),
      }),
    ]);
    expect(writes.filter((w) => w.status === "fulfilled")).toHaveLength(1);
    expect(writes.find((w) => w.status === "rejected").reason.status).toBe(409);
    await expect(
      api.updateLead(second, company, lead.leadId, {
        expectedVersion: 3,
        lead: { ...input(second), stage: "qualified" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const closed = await api.updateLead(second, company, lead.leadId, {
      expectedVersion: 3,
      lead: {
        ...input(second),
        stage: "closed",
        stageReason: "Customer asked to close this enquiry.",
      },
    });
    expect(closed.lead.ownership).toBe("paused");
    await expect(
      api.changeOwnership(second, company, lead.leadId, {
        expectedVersion: closed.lead.ownershipVersion,
        ownership: "human",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("uses bounded server pagination and sorting, with privacy-limited list projections", async () => {
    const release = (
      await pool.query(
        "SELECT release_id FROM sophia_runtime.lead_assistant_setting_releases WHERE customer_id=$1",
        [tenant],
      )
    ).rows[0].release_id;
    const inserted = await pool.query(
      `INSERT INTO sophia_runtime.assistant_leads(customer_id,display_name,language,assigned_to_identity,settings_release_id,request_key,request_hash,created_by_identity)
    SELECT $1,'Paging '||lpad(n::text,3,'0'),'es',$2,$3,gen_random_uuid(),'fixture',$2 FROM generate_series(1,60)n RETURNING lead_id`,
      [tenant, second, release],
    );
    for (const row of inserted.rows)
      await pool.query(
        "INSERT INTO sophia_runtime.assistant_lead_conversations(customer_id,lead_id) VALUES($1,$2)",
        [tenant, row.lead_id],
      );
    const first = await api.listLeads(second, company, {
      q: "Paging",
      sort: "name",
      direction: "asc",
      page: 1,
      limit: 25,
    });
    const page2 = await api.listLeads(second, company, {
      q: "Paging",
      sort: "name",
      direction: "asc",
      page: 2,
      limit: 25,
    });
    expect(first.total).toBe(60);
    expect(first.items).toHaveLength(25);
    expect(page2.items[0].displayName).toBe("Paging 026");
    expect(first.items[0].email).toBeUndefined();
    expect(first.items[0].phone).toBeUndefined();
  });
  test("pages conversation history by a bounded cursor without loading the whole transcript", async () => {
    await pool.query(
      "INSERT INTO sophia_runtime.assistant_lead_events(customer_id,conversation_id,kind,body,actor_identity) SELECT $1,$2,'note','History '||n,$3 FROM generate_series(1,55)n",
      [tenant, otherLead.conversationId, second],
    );
    const recent = await api.getLead(second, company, otherLead.leadId);
    expect(recent.events).toHaveLength(50);
    expect(recent.hasOlder).toBe(true);
    const older = await api.olderEvents(
      second,
      company,
      otherLead.leadId,
      recent.events[0].id,
    );
    expect(older.events.length).toBeLessThanOrEqual(50);
    expect(older.events.some((e) => e.id === recent.events[0].id)).toBe(false);
    await expect(
      api.olderEvents(second, company, otherLead.leadId, "9223372036854775808"),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("revokes inbox access immediately for inactive or removed team members", async () => {
    await pool.query("UPDATE public.users SET status='archived' WHERE id=$1", [
      advisor,
    ]);
    await expect(api.inboxContext(advisor, company)).rejects.toMatchObject({
      status: 403,
    });
    const changed = { ...config(), advisorIds: [advisor] };
    await pool.query("UPDATE public.users SET status='active' WHERE id=$1", [
      advisor,
    ]);
    await settings.saveSettings(owner, company, {
      expectedRevision: 1,
      configuration: changed,
    });
    await settings.publishSettings(owner, company, { expectedRevision: 2 });
    await expect(
      api.getLead(second, company, otherLead.leadId),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await api.getLead(owner, company, otherLead.leadId)).lead.leadId,
    ).toBe(otherLead.leadId);
  });
  test("prevents a lead from referencing another tenant settings release", async () => {
    const release = (
      await pool.query(
        "INSERT INTO sophia_runtime.lead_assistant_setting_releases(customer_id,source_revision,configuration,published_by_identity) VALUES($1,1,'{}',$2) RETURNING release_id",
        [otherTenant, outsider],
      )
    ).rows[0].release_id;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenant]);
      await expect(
        db.query(
          "INSERT INTO sophia_runtime.assistant_leads(customer_id,display_name,language,settings_release_id,request_key,request_hash,created_by_identity) VALUES($1,'Spoof','es',$2,$3,'fixture',$4)",
          [tenant, release, randomUUID(), owner],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
  });
  test("enforces app-role tenant RLS and append-only notes despite inherited default grants", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (await db.query("SELECT * FROM sophia_runtime.assistant_leads")).rows,
      ).toHaveLength(0);
      await db.query("ROLLBACK");
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenant]);
      await expect(
        db.query(
          "UPDATE sophia_runtime.assistant_lead_events SET body='tampered'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
  });
});
