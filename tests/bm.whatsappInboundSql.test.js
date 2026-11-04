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
const url = process.env.LOCAL_WHATSAPP_TEST_DATABASE_URL;
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
const channel = await import(
  "../src/services/messaging/whatsapp-channel.service.js"
);
const { normalizePayload } = await import(
  "../src/adapters/whatsapp/inbound.js"
);
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
suite("WhatsApp channel on PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sophia_runtime_app') THEN CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS;END IF;END $$;
   CREATE SCHEMA sophia_runtime;GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
   CREATE TABLE public.users(id uuid PRIMARY KEY,company_id uuid,status text,type text,name text);
   CREATE TABLE public.bm_company(company_id uuid PRIMARY KEY,status text);
   CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
   CREATE TABLE sophia_runtime.admin_memberships(customer_id uuid,identity_user_id text,status text,role_key text);
   CREATE TABLE sophia_runtime.business_pack_entitlements(customer_id uuid,identity_user_id text,status text,pack_id text,role_key text);
   CREATE TABLE sophia_runtime.platform_operator_assignments(identity_user_id text,operator_company_id uuid,status text);
   GRANT SELECT ON sophia_runtime.customers TO sophia_runtime_app;
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
      "118_whatsapp_inbound_channel.sql",
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
    delete process.env.WHATSAPP_INBOUND_PROFILES;
    delete process.env.WHATSAPP_TEST_SECRET;
    delete process.env.WHATSAPP_TEST_VERIFY;
    await pool.end();
  });
  const profile = {
    id: "pilot_test",
    label: "Pilot test",
    customerId: tenant,
    phoneNumberId: "654321",
    businessAccountId: "123456",
    appSecretEnv: "WHATSAPP_TEST_SECRET",
    verifyTokenEnv: "WHATSAPP_TEST_VERIFY",
  };
  const event = (id = "wamid.1", extra = {}) => ({
    key: "message:" + id,
    kind: "inbound",
    messageId: id,
    senderId: "61412345678",
    body: "Hello",
    messageType: "text",
    displayName: "WhatsApp Example",
    sentAt: "2026-11-03T00:00:00Z",
    ...extra,
  });
  const put = (enabled = true, expectedRevision = 0) =>
    channel.configureChannel(owner, company, {
      profileId: profile.id,
      enabled,
      expectedRevision,
    });
  test("enables receiving only with manager authority, ready allowlisted secrets and published Settings", async () => {
    process.env.WHATSAPP_INBOUND_PROFILES = JSON.stringify([profile]);
    process.env.WHATSAPP_TEST_SECRET = "long-test-secret-for-local";
    process.env.WHATSAPP_TEST_VERIFY = "long-test-verify-for-local";
    await expect(put()).rejects.toMatchObject({ status: 409 });
    await settings.saveSettings(owner, company, {
      expectedRevision: 0,
      configuration: config(),
    });
    await settings.publishSettings(owner, company, { expectedRevision: 1 });
    await expect(
      channel.configureChannel(advisor, company, {
        profileId: profile.id,
        enabled: true,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await put()).enabled).toBe(true);
    await expect(put()).rejects.toMatchObject({ status: 409 });
    await expect(
      channel.configureChannel(outsider, otherCompany, {
        profileId: profile.id,
        enabled: true,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const status = await channel.channelStatus(owner, company);
    expect(status.profiles[0]).toEqual({
      id: profile.id,
      label: profile.label,
      ready: true,
    });
    expect(JSON.stringify(status)).not.toContain(
      process.env.WHATSAPP_TEST_SECRET,
    );
  });
  test("durably queues a signed-normalized batch before processing and deduplicates provider replays", async () => {
    const before = Number(
      (await pool.query("SELECT count(*) FROM public.users")).rows[0].count,
    );
    expect(await channel.receiveEvents(profile, [event(), event()])).toEqual({
      inserted: 1,
    });
    expect((await api.listLeads(owner, company, {})).total).toBe(0);
    expect(await channel.processChannelEvent(profile)).toEqual({
      processed: true,
    });
    const list = await api.listLeads(owner, company, {});
    expect(list.total).toBe(1);
    lead = list.items[0];
    const detail = await api.getLead(owner, company, lead.leadId);
    expect(detail.lead).toMatchObject({
      source: "whatsapp",
      assignedTo: queueOwner,
      ownership: "human_requested",
      displayName: "WhatsApp Example",
    });
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0].body).toBe("Hello");
    expect(
      (
        await pool.query(
          "SELECT event FROM sophia_runtime.assistant_channel_receipts",
        )
      ).rows[0].event,
    ).not.toHaveProperty("body");
    expect(await channel.receiveEvents(profile, [event()])).toEqual({
      inserted: 0,
    });
    expect(await channel.processChannelEvent(profile)).toEqual({
      processed: false,
    });
    expect(
      Number(
        (await pool.query("SELECT count(*) FROM public.users")).rows[0].count,
      ),
    ).toBe(before);
  });
  test("concurrent messages reuse one exact channel identity without merging by display name", async () => {
    await channel.receiveEvents(profile, [event("wamid.2"), event("wamid.3")]);
    await Promise.all([
      channel.processChannelEvent(profile),
      channel.processChannelEvent(profile),
    ]);
    expect((await api.listLeads(owner, company, {})).total).toBe(1);
    expect(
      (await api.getLead(owner, company, lead.leadId)).events,
    ).toHaveLength(3);
    await channel.receiveEvents(profile, [
      event("wamid.other", { senderId: "61499999999" }),
    ]);
    await channel.processChannelEvent(profile);
    expect((await api.listLeads(owner, company, {})).total).toBe(2);
  });
  test("Business App echoes pause human/automated ownership without opening a reply window", async () => {
    let detail = await api.getLead(owner, company, lead.leadId);
    await api.changeOwnership(owner, company, lead.leadId, {
      expectedVersion: detail.lead.ownershipVersion,
      ownership: "human",
    });
    await channel.receiveEvents(profile, [
      event("echo.1", {
        key: "echo:echo.1",
        kind: "app_echo",
        body: "Reply from mobile",
      }),
    ]);
    await channel.processChannelEvent(profile);
    detail = await api.getLead(owner, company, lead.leadId);
    expect(detail.lead.ownership).toBe("paused");
    expect(detail.lead.humanOwner).toBeNull();
    expect(detail.events.at(-1)).toMatchObject({
      kind: "outbound_message",
      body: "Reply from mobile",
    });
    const contact = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_channel_contacts WHERE lead_id=$1",
        [lead.leadId],
      )
    ).rows[0];
    expect(new Date(contact.last_inbound_at).toISOString()).toBe(
      "2026-11-03T00:00:00.000Z",
    );
  });
  test("opt-out is sticky, old messages do not regress last inbound, closed leads stay closed", async () => {
    const d = await api.getLead(owner, company, lead.leadId);
    const {
      leadId,
      version,
      email,
      phone,
      displayName,
      language,
      interest,
      location,
      timeframe,
      assignedTo,
    } = d.lead;
    await api.updateLead(owner, company, leadId, {
      expectedVersion: version,
      lead: {
        email,
        phone,
        displayName,
        language,
        interest,
        location,
        timeframe,
        assignedTo,
        stage: "closed",
        stageReason: "Customer request",
      },
    });
    await channel.receiveEvents(profile, [
      event("stop", { body: "STOP", sentAt: "2026-11-03T01:00:00Z" }),
      event("old", { sentAt: "2026-11-02T00:00:00Z" }),
    ]);
    await channel.processChannelEvent(profile);
    await channel.processChannelEvent(profile);
    expect((await api.getLead(owner, company, leadId)).lead.stage).toBe(
      "closed",
    );
    const c = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_channel_contacts WHERE lead_id=$1",
        [leadId],
      )
    ).rows[0];
    expect(c.opted_out).toBe(true);
    expect(new Date(c.last_inbound_at).toISOString()).toBe(
      "2026-11-03T01:00:00.000Z",
    );
  });
  test("delivery receipts and unsupported fields do not create phantom leads", async () => {
    await channel.receiveEvents(profile, [
      {
        key: "status:wamid.sent:read:1",
        kind: "delivery",
        status: "read",
        messageId: "wamid.sent",
      },
      { key: "unsupported:1", kind: "unsupported", field: "account_update" },
    ]);
    await channel.processChannelEvent(profile);
    await channel.processChannelEvent(profile);
    expect((await api.listLeads(owner, company, {})).total).toBe(2);
  });
  test("pausing is fail-closed for ingress and workers, preserves queue for explicit resume", async () => {
    await channel.receiveEvents(profile, [event("paused")]);
    await put(false, 1);
    await expect(
      channel.receiveEvents(profile, [event("reject")]),
    ).rejects.toMatchObject({ status: 503 });
    await expect(channel.processChannelEvent(profile)).rejects.toMatchObject({
      status: 503,
    });
    await put(true, 2);
    expect(await channel.processChannelEvent(profile)).toEqual({
      processed: true,
    });
  });
  test("worker failures roll back partial lead writes, back off, and exhaust into visible attention state", async () => {
    await channel.receiveEvents(profile, [
      event("bad", {
        senderId: "61488888888",
        messageType: "text",
        body: "x".repeat(4001),
      }),
    ]);
    for (let attempt = 1; attempt <= 8; attempt++) {
      await pool.query(
        "UPDATE sophia_runtime.assistant_channel_receipts SET available_at=now() WHERE state='queued'",
      );
      const result = await channel.processChannelEvent(profile);
      expect(result.retry).toBe(true);
      expect(result.failed).toBe(attempt === 8);
    }
    expect((await api.listLeads(owner, company, {})).total).toBe(2);
    const status = await channel.channelStatus(owner, company);
    expect(status.health.failed).toBe(1);
    expect(status.health.queued).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT failure_code FROM sophia_runtime.assistant_channel_receipts WHERE state='failed'",
        )
      ).rows[0].failure_code,
    ).toBe("processing_failed");
  });
  test("app-role RLS hides other-tenant channel data and rejects deletion despite inherited grants", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
        otherTenant,
      ]);
      for (const table of [
        "assistant_channels",
        "assistant_channel_contacts",
        "assistant_channel_receipts",
      ])
        expect(
          (await db.query("SELECT * FROM sophia_runtime." + table)).rows,
        ).toHaveLength(0);
      await db.query("ROLLBACK");
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenant]);
      await expect(
        db.query("DELETE FROM sophia_runtime.assistant_channels"),
      ).rejects.toMatchObject({ code: "42501" });
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
  });
});
