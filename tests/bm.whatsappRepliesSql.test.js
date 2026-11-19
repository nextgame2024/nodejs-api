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
const url = process.env.LOCAL_WHATSAPP_REPLY_TEST_DATABASE_URL;
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
const replies = await import("../src/services/messaging/reply-api.service.js");
const worker = await import("../src/services/messaging/reply-worker.js");
const appointments = await import(
  "../src/services/scheduling/lead-appointments.service.js"
);
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
  appointmentBookingEnabled: true,
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
suite("WhatsApp replies on PostgreSQL", () => {
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
    await pool.query(`
 CREATE TABLE sophia_runtime.experience_profiles(experience_profile_id uuid PRIMARY KEY,customer_id uuid,enabled boolean);
 CREATE TABLE sophia_runtime.experience_profile_versions(experience_profile_version_id uuid PRIMARY KEY,experience_profile_id uuid,business_profile_version_id uuid,status text,pipeline_mode text);
 CREATE TABLE sophia_runtime.experience_provider_bindings(experience_profile_version_id uuid,provider_configuration_id uuid,capability_key text);
 CREATE TABLE sophia_runtime.provider_configurations(provider_configuration_id uuid PRIMARY KEY,customer_id uuid,status text,adapter_key text,credential_ref text,settings jsonb);
 GRANT SELECT ON sophia_runtime.experience_profiles,sophia_runtime.experience_profile_versions,sophia_runtime.experience_provider_bindings,sophia_runtime.provider_configurations TO sophia_runtime_app;
 CREATE TABLE sophia_runtime.agents(agent_id uuid PRIMARY KEY,customer_id uuid,status text,agent_key text,active_release_id uuid);
 CREATE TABLE sophia_runtime.instruction_sets(instruction_set_id uuid PRIMARY KEY,customer_id uuid);
 CREATE TABLE sophia_runtime.instruction_revisions(instruction_revision_id uuid PRIMARY KEY,instruction_set_id uuid,status text,content text,tone text,greeting text);
 CREATE TABLE sophia_runtime.agent_release_manifests(agent_release_id uuid PRIMARY KEY,agent_id uuid,customer_id uuid,manifest jsonb,platform_safety_policy_version text,release_number int,UNIQUE(agent_release_id,customer_id));
 CREATE TABLE sophia_runtime.agent_release_revocations(agent_release_id uuid);
 CREATE TABLE sophia_runtime.knowledge_sources(knowledge_source_id uuid PRIMARY KEY,customer_id uuid,status text);
 CREATE TABLE sophia_runtime.knowledge_source_revisions(knowledge_revision_id uuid PRIMARY KEY,customer_id uuid,knowledge_source_id uuid,status text,ingestion_status text);
 CREATE TABLE sophia_runtime.knowledge_snapshots(knowledge_snapshot_id uuid PRIMARY KEY,customer_id uuid,knowledge_revision_id uuid,status text);
 CREATE TABLE sophia_runtime.knowledge_index_documents(knowledge_snapshot_id uuid,customer_id uuid,title text,document_text text,search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple',title||' '||document_text)) STORED);
 CREATE TABLE sophia_runtime.capability_bindings(capability_binding_id uuid PRIMARY KEY,business_profile_version_id uuid,enabled boolean);
 CREATE TABLE sophia_runtime.knowledge_snapshot_grants(customer_id uuid,knowledge_snapshot_id uuid,capability_binding_id uuid);
 GRANT SELECT ON sophia_runtime.agents,sophia_runtime.instruction_sets,sophia_runtime.instruction_revisions,sophia_runtime.agent_release_manifests,sophia_runtime.agent_release_revocations,sophia_runtime.knowledge_sources,sophia_runtime.knowledge_source_revisions,sophia_runtime.knowledge_snapshots,sophia_runtime.knowledge_index_documents,sophia_runtime.capability_bindings,sophia_runtime.knowledge_snapshot_grants TO sophia_runtime_app;
 `);
    await pool.query(
      (
        await readFile(
          new URL(
            "../sophia-runtime/src/database/migrations/119_whatsapp_replies.sql",
            import.meta.url,
          ),
          "utf8",
        )
      ).replaceAll("__SOPHIA_RUNTIME_SCHEMA__", "sophia_runtime"),
    );
    for (const name of [
      "121_lead_appointments.sql",
      "122_whatsapp_appointment_confirmation.sql",
      "123_whatsapp_appointment_changes.sql",
      "135_lead_discovery_assessments.sql",
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
    delete process.env.WHATSAPP_OUTBOUND_ENABLED;
    delete process.env.WHATSAPP_GENERATION_ENABLED;
    delete process.env.WHATSAPP_AUTOMATION_ENABLED;
    delete process.env.WHATSAPP_BOOKING_ENABLED;
    delete process.env.WHATSAPP_TEST_SEND;
    delete process.env.WHATSAPP_TEST_SECRET;
    delete process.env.WHATSAPP_TEST_VERIFY;
    await pool.end();
  });
  const release = randomUUID(),
    agent = randomUUID(),
    instruction = randomUUID(),
    instructionSet = randomUUID(),
    knowledge = randomUUID(),
    snapshot = randomUUID(),
    source = randomUUID(),
    capability = randomUUID(),
    business = randomUUID();
  const profile = {
    id: "pilot_test",
    label: "Pilot test",
    customerId: tenant,
    phoneNumberId: "654321",
    businessAccountId: "123456",
    appSecretEnv: "WHATSAPP_TEST_SECRET",
    verifyTokenEnv: "WHATSAPP_TEST_VERIFY",
    accessTokenEnv: "WHATSAPP_TEST_SEND",
    graphVersion: "v25.0",
    sendingEnabled: true,
    reasoningAdapter: "test",
    reasoningCredentialRef: "env://test",
  };
  const full = { ...profile, ready: true, accessToken: "local-test-token" };
  const inbound = async (id, extra = {}, activeProfile = full) => {
    await channel.receiveEvents(activeProfile, [
      {
        key: "message:" + id,
        kind: "inbound",
        messageId: id,
        senderId: "61412345678",
        body: "English course price",
        messageType: "text",
        displayName: "Example",
        sentAt: new Date(Date.now() - 1000).toISOString(),
        ...extra,
      },
    ]);
    await channel.processChannelEvent(activeProfile);
  };
  const takeover = async () => {
    const d = await api.getLead(owner, company, lead.leadId);
    return api.changeOwnership(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
      ownership: "human",
    });
  };
  const queue = async (key = randomUUID(), body = "Hello from team") => {
    const d = await api.getLead(owner, company, lead.leadId);
    return replies.queueReply(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
      requestKey: key,
      body,
    });
  };
  const approved = async () => ({
    handoff: false,
    answer: "The English course costs AUD 100.",
    sourceIds: [snapshot],
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  });
  test("configures an approved tenant release; rejects cross-tenant and unpublished instructions", async () => {
    process.env.WHATSAPP_INBOUND_PROFILES = JSON.stringify([profile]);
    process.env.WHATSAPP_TEST_SECRET = "local-test-secret-long";
    process.env.WHATSAPP_TEST_VERIFY = "local-test-verify-long";
    process.env.WHATSAPP_TEST_SEND = "local-test-token";
    process.env.WHATSAPP_OUTBOUND_ENABLED = "true";
    process.env.WHATSAPP_GENERATION_ENABLED = "true";
    await settings.saveSettings(owner, company, {
      expectedRevision: 0,
      configuration: config(),
    });
    await settings.publishSettings(owner, company, { expectedRevision: 1 });
    await channel.configureChannel(owner, company, {
      profileId: profile.id,
      enabled: true,
      expectedRevision: 0,
    });
    await pool.query(
      "INSERT INTO sophia_runtime.agents VALUES($1,$2,'enabled','public-assistant',$3)",
      [agent, tenant, release],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.instruction_sets VALUES($1,$2)",
      [instructionSet, tenant],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.instruction_revisions VALUES($1,$2,'draft','Answer courteously',NULL,NULL)",
      [instruction, instructionSet],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.agent_release_manifests VALUES($1,$2,$3,$4,'sophia-safety-1',1)",
      [
        release,
        agent,
        tenant,
        {
          schemaVersion: 1,
          tenantId: tenant,
          configuration: {
            instructionRevisionId: instruction,
            knowledgeRevisionIds: [knowledge],
            experienceProfileVersionIds: [business],
            capabilityBindingIds: [capability],
            businessProfileVersionId: business,
          },
        },
      ],
    );
    await expect(
      replies.bindResponse(owner, company, {
        profileId: profile.id,
        releaseId: release,
        mode: "review",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await pool.query(
      "UPDATE sophia_runtime.instruction_revisions SET status='approved'",
    );
    expect(
      (
        await replies.bindResponse(owner, company, {
          profileId: profile.id,
          releaseId: release,
          mode: "review",
          expectedRevision: 0,
        })
      ).revision,
    ).toBe(1);
    await expect(
      replies.bindResponse(advisor, company, {
        profileId: profile.id,
        releaseId: release,
        mode: "review",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await pool.query(
      "INSERT INTO sophia_runtime.knowledge_sources VALUES($1,$2,'active')",
      [source, tenant],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.knowledge_source_revisions VALUES($1,$2,$3,'published','ready')",
      [knowledge, tenant, source],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.knowledge_snapshots VALUES($1,$2,$3,'published')",
      [snapshot, tenant, knowledge],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.knowledge_index_documents(knowledge_snapshot_id,customer_id,title,document_text) VALUES($1,$2,'English course','English course price AUD 100')",
      [snapshot, tenant],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.capability_bindings VALUES($1,$2,true)",
      [capability, business],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.knowledge_snapshot_grants VALUES($1,$2,$3)",
      [tenant, snapshot, capability],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.experience_profiles VALUES($1,$2,true)",
      [business, tenant],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.experience_profile_versions VALUES($1,$1,$1,'published','orchestrated-text')",
      [business],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.provider_configurations VALUES($1,$2,'published','test','env://test','{}')",
      [business, tenant],
    );
    await pool.query(
      "INSERT INTO sophia_runtime.experience_provider_bindings VALUES($1,$1,'reasoning')",
      [business],
    );
    await inbound("first");
    lead = (await api.listLeads(owner, company, {})).items[0];
  });
  test("human replies require takeover and a valid window; retries are idempotent", async () => {
    await expect(queue()).rejects.toMatchObject({ status: 409 });
    await takeover();
    const key = randomUUID();
    await queue(key);
    await queue(key);
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox",
        )
      ).rowCount,
    ).toBe(1);
    await expect(queue(key, "Different")).rejects.toMatchObject({
      status: 409,
    });
    const send = jest.fn().mockResolvedValue({
      kind: "accepted",
      providerMessageId: "wamid.sent.1",
    });
    expect(await worker.dispatchOne(full, send)).toEqual({ processed: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await api.getLead(owner, company, lead.leadId)).events.at(-1).body,
    ).toBe("Hello from team");
  });
  test("late delivery statuses are monotonic and duplicate acknowledgements do not duplicate messages", async () => {
    for (const status of ["read", "delivered", "sent", "read"]) {
      await channel.receiveEvents(full, [
        {
          key: "status:" + status,
          kind: "delivery",
          status,
          messageId: "wamid.sent.1",
        },
      ]);
      await channel.processChannelEvent(full);
    }
    expect(
      (
        await pool.query(
          "SELECT state FROM sophia_runtime.assistant_message_outbox",
        )
      ).rows[0].state,
    ).toBe("read");
    expect(
      (await api.getLead(owner, company, lead.leadId)).events.filter(
        (e) => e.kind === "outbound_message",
      ),
    ).toHaveLength(1);
  });
  test("ownership changes cancel queued work; opt-out and expired windows reject new sends", async () => {
    await queue();
    const d = await api.getLead(owner, company, lead.leadId);
    await api.changeOwnership(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
      ownership: "paused",
    });
    const send = jest.fn();
    await worker.dispatchOne(full, send);
    expect(send).not.toHaveBeenCalled();
    await takeover();
    await pool.query(
      "UPDATE sophia_runtime.assistant_channel_contacts SET last_inbound_at=now()-interval '25 hours'",
    );
    await expect(queue()).rejects.toMatchObject({ status: 409 });
    await inbound("recent");
    await pool.query(
      "UPDATE sophia_runtime.assistant_channel_contacts SET opted_out=true",
    );
    await expect(queue()).rejects.toMatchObject({ status: 409 });
    await pool.query(
      "UPDATE sophia_runtime.assistant_channel_contacts SET opted_out=false",
    );
  });
  test("ambiguous sends never retry automatically and reconcile by callback identity", async () => {
    await queue();
    const send = jest
      .fn()
      .mockResolvedValue({ kind: "unknown", code: "send_unconfirmed" });
    await worker.dispatchOne(full, send);
    await worker.dispatchOne(full, send);
    expect(send).toHaveBeenCalledTimes(1);
    const m = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE state='unknown'",
      )
    ).rows[0];
    await channel.receiveEvents(full, [
      {
        key: "recover",
        kind: "delivery",
        status: "delivered",
        messageId: "wamid.recovered",
        callbackId: m.message_id,
      },
    ]);
    await channel.processChannelEvent(full);
    expect(
      (
        await pool.query(
          "SELECT state FROM sophia_runtime.assistant_message_outbox WHERE message_id=$1",
          [m.message_id],
        )
      ).rows[0].state,
    ).toBe("delivered");
  });
  test("bounded rate-limit retries recheck eligibility before sending", async () => {
    await queue();
    const send = jest.fn().mockResolvedValue({ kind: "retry", seconds: 60 });
    await worker.dispatchOne(full, send);
    await worker.dispatchOne(full, send);
    expect(send).toHaveBeenCalledTimes(1);
    await pool.query(
      "UPDATE sophia_runtime.assistant_message_outbox SET available_at=now() WHERE state='queued'",
    );
    await pool.query(
      "UPDATE sophia_runtime.assistant_channel_contacts SET opted_out=true",
    );
    await worker.dispatchOne(full, send);
    expect(send).toHaveBeenCalledTimes(1);
    await pool.query(
      "UPDATE sophia_runtime.assistant_channel_contacts SET opted_out=false",
    );
  });
  test("draft generation uses only pinned published knowledge and never sends a reviewed draft automatically", async () => {
    const d = await api.getLead(owner, company, lead.leadId);
    await replies.draftReply(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
    });
    const reason = jest.fn(approved);
    expect(await worker.generateOne(full, reason)).toEqual({ processed: true });
    expect(reason.mock.calls[0][0].sources).toEqual([
      expect.objectContaining({ id: snapshot }),
    ]);
    const result = await api.getLead(owner, company, lead.leadId);
    expect(result.reply.jobs[0].state).toBe("ready");
    expect(result.reply.jobs[0].answer).toContain("AUD 100");
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE state='queued'",
        )
      ).rowCount,
    ).toBe(0);
  });

  test("changing the response binding permits a fresh draft and generation failures have a bounded explicit retry", async () => {
    await replies.bindResponse(owner, company, {
      profileId: profile.id,
      releaseId: release,
      mode: "review",
      expectedRevision: 1,
    });
    const d = await api.getLead(owner, company, lead.leadId);
    await replies.draftReply(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
    });
    await worker.generateOne(full, async () => {
      throw new Error("temporary failure");
    });
    await replies.draftReply(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
    });
    await worker.generateOne(full, approved);
    const jobs = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_reply_jobs WHERE lead_id=$1 ORDER BY created_at DESC",
        [lead.leadId],
      )
    ).rows;
    expect(jobs[0].binding_revision).toBe(2);
    expect(jobs[0].state).toBe("ready");
    expect(jobs[0].attempts).toBe(2);
    expect(jobs[0].usage.attempts).toHaveLength(2);
  });
  test("automatic enquiries generate one grounded answer; takeover during generation discards stale output", async () => {
    process.env.WHATSAPP_AUTOMATION_ENABLED = "true";
    await replies.bindResponse(owner, company, {
      profileId: profile.id,
      releaseId: release,
      mode: "automatic",
      expectedRevision: 2,
    });
    await inbound("auto-new", { senderId: "61499999999" });
    const row = (await api.listLeads(owner, company, {})).items.find(
      (i) => i.leadId !== lead.leadId,
    );
    expect(row.ownership).toBe("bot");
    await worker.generateOne(full, async () => {
      const d = await api.getLead(owner, company, row.leadId);
      await api.changeOwnership(owner, company, row.leadId, {
        expectedVersion: d.lead.ownershipVersion,
        ownership: "human",
      });
      return approved();
    });
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE lead_id=$1 AND state='queued'",
          [row.leadId],
        )
      ).rowCount,
    ).toBe(0);
    await inbound("auto-real", { senderId: "61488888888" });
    expect(await worker.generateOne(full, approved)).toEqual({
      processed: true,
    });
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE state='queued'",
        )
      ).rowCount,
    ).toBe(1);
  });
  test("asks missing contact details once, and continues after the customer skips them", async () => {
    const senderId = "61488880000";
    await inbound("contact-initial", { senderId });
    await worker.generateOne(full, approved);
    const first = (
      await pool.query(
        "SELECT j.answer,j.usage,j.lead_id FROM sophia_runtime.assistant_reply_jobs j JOIN sophia_runtime.assistant_channel_contacts t USING(customer_id,lead_id) WHERE t.sender_id=$1 ORDER BY j.created_at DESC LIMIT 1",
        [senderId],
      )
    ).rows[0];
    expect(first.usage.engagement.contactRequested).toBe(true);
    expect(first.answer).toContain("nombre y correo");
    await inbound("contact-skipped", {
      senderId,
      body: "Tell me more about the English course price",
    });
    await worker.generateOne(full, approved);
    const second = (
      await pool.query(
        "SELECT answer,usage FROM sophia_runtime.assistant_reply_jobs WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [first.lead_id],
      )
    ).rows[0];
    expect(second.answer).toContain("AUD 100");
    expect(second.usage.engagement.contactRequested).toBeUndefined();
    expect(second.answer).not.toContain("nombre y correo");
    await inbound("contact-supplied", {
      senderId,
      body: "José Muñoz, jose@example.com",
    });
    const contactLead = (
      await pool.query(
        "SELECT display_name,email FROM sophia_runtime.assistant_leads WHERE lead_id=$1",
        [first.lead_id],
      )
    ).rows[0];
    expect(contactLead).toMatchObject({
      display_name: "José Muñoz",
      email: "jose@example.com",
    });
    const ack = (
      await pool.query(
        "SELECT body FROM sophia_runtime.assistant_message_outbox WHERE lead_id=$1 AND request_hash LIKE 'contact_ack:%'",
        [first.lead_id],
      )
    ).rows[0];
    expect(ack.body).toContain("guardé tus datos");
    const reasoner = jest.fn(approved);
    await worker.generateOne(full, reasoner);
    expect(reasoner).not.toHaveBeenCalled();
    const sent = [];
    // Earlier tests can leave other queued messages; target acknowledgement is
    // checked directly and the normal dispatch validates its latest-event guard.
    for (let i = 0; i < 4; i++)
      await worker.dispatchOne(full, async (p, m) => {
        sent.push(m.body);
        return { kind: "accepted", providerMessageId: randomUUID() };
      });
    expect(sent.some((body) => body.includes("guardé tus datos"))).toBe(true);
    const d = await api.getLead(owner, company, first.lead_id);
    await api.changeOwnership(owner, company, first.lead_id, {
      expectedVersion: d.lead.ownershipVersion,
      ownership: "human",
    });
  });
  test("an unanswerable turn sends one recovery notice and keeps the next turn active", async () => {
    await inbound("handoff-notice", {
      senderId: "61455550001",
      body: "English course help",
    });
    await worker.generateOne(full, async () => ({
      handoff: true,
      answer: "",
      sourceIds: [],
    }));
    const job = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_reply_jobs ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    expect(job.state).toBe("needs_human");
    const c = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_lead_conversations WHERE conversation_id=$1",
        [job.conversation_id],
      )
    ).rows[0];
    expect(c.ownership).toBe("bot");
    const outbox = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE job_id=$1",
        [job.job_id],
      )
    ).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].body).toBe(worker.handoffNotice("es"));
    expect(outbox[0].ownership_version).toBe(c.ownership_version);
    // Let any earlier approved reply dispatch first; notice is still sent once.
    const send = jest.fn().mockImplementation(async () => ({
      kind: "accepted",
      providerMessageId: randomUUID(),
    }));
    for (let i = 0; i < 4; i++) await worker.dispatchOne(full, send);
    expect(
      (
        await pool.query(
          "SELECT state FROM sophia_runtime.assistant_message_outbox WHERE job_id=$1",
          [job.job_id],
        )
      ).rows[0].state,
    ).toBe("accepted");
    expect(
      (
        await pool.query(
          "SELECT ownership FROM sophia_runtime.assistant_lead_conversations WHERE conversation_id=$1",
          [job.conversation_id],
        )
      ).rows[0].ownership,
    ).toBe("bot");
    await inbound("after-recovery", {
      senderId: "61455550001",
      body: "English course price",
    });
    const nextReason = jest.fn(approved);
    await worker.generateOne(full, nextReason);
    expect(nextReason).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) await worker.dispatchOne(full, send);
    expect(worker.handoffNotice("es")).toContain("Sigo aquí");
    expect(worker.handoffNotice("pt")).toContain("Continuo aqui");
  });
  test("discovery remembers public messages, excludes staff notes, persists evidence and protects follow-up access", async () => {
    const discoveryProfile = { ...full, qualificationEnabled: true };
    const sender = "61477776666";
    await inbound("discovery-first", {
      senderId: sender,
      body: "We run a plumbing business and lose customer enquiries.",
    });
    const reason = jest.fn(async (task) => {
      const e = task.transcript.at(-1);
      return {
        ...(await approved()),
        discoveryFacts: [
          { field: "business", quote: "plumbing business", eventId: e.id },
          { field: "need", quote: "lose customer enquiries", eventId: e.id },
          { field: "outcome", quote: "invented outcome", eventId: e.id },
        ],
      };
    });
    await worker.generateOne(discoveryProfile, reason);
    expect(reason).toHaveBeenCalledTimes(1);
    expect(reason.mock.calls[0][0].sources[0].id).toBe(snapshot); // short/no-match fallback stays granted
    const id = (
      await pool.query(
        "SELECT lead_id FROM sophia_runtime.assistant_channel_contacts WHERE sender_id=$1",
        [sender],
      )
    ).rows[0].lead_id;
    let d = await api.getLead(owner, company, id);
    expect(d.discovery.assessment.score).toBe(45);
    expect(d.discovery.facts.outcome).toBeUndefined();
    await api.addNote(owner, company, id, {
      requestKey: randomUUID(),
      body: "PRIVATE STAFF NOTE: never send to provider",
    });
    await inbound("discovery-second", {
      senderId: sender,
      body: "We want faster responses. Next month.",
    });
    const secondReason = jest.fn(async (task) => {
      const e = task.transcript.at(-1);
      return {
        ...(await approved()),
        discoveryFacts: [
          { field: "outcome", quote: "faster responses", eventId: e.id },
          { field: "timeframe", quote: "Next month", eventId: e.id },
        ],
      };
    });
    await worker.generateOne(discoveryProfile, secondReason);
    const task = secondReason.mock.calls[0][0];
    expect(task.transcript.map((x) => x.text).join(" ")).toContain(
      "plumbing business",
    );
    expect(JSON.stringify(task)).not.toContain("PRIVATE STAFF NOTE");
    expect(task.discoveryContext.facts.need.quote).toBe(
      "lose customer enquiries",
    );
    d = await api.getLead(owner, company, id);
    expect(d.discovery.assessment.score).toBe(80);
    expect(d.discovery.assessment.priority).toBe("high");
    const change = {
      expectedRevision: d.discovery.revision,
      status: "completed",
    };
    await expect(
      api.updateFollowUp(outsider, otherCompany, id, change),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      api.updateFollowUp(advisor, company, id, change),
    ).rejects.toMatchObject({ status: 404 });
    d = await api.updateFollowUp(owner, company, id, change);
    expect(d.discovery.followUpStatus).toBe("completed");
    await expect(
      api.updateFollowUp(owner, company, id, change),
    ).rejects.toMatchObject({ status: 409 });
    await inbound("discovery-third", {
      senderId: sender,
      body: "We use spreadsheets",
    });
    await worker.generateOne(discoveryProfile, async (task) => ({
      ...(await approved()),
      discoveryFacts: [
        {
          field: "systems",
          quote: "spreadsheets",
          eventId: task.transcript.at(-1).id,
        },
      ],
    }));
    d = await api.getLead(owner, company, id);
    expect(d.discovery.followUpStatus).toBe("completed");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE sophia_runtime_app");
      await client.query("SELECT set_config('sophia.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (
          await client.query(
            "SELECT * FROM sophia_runtime.assistant_lead_assessments",
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  test("explicit one-time reminders are idempotent, cancel on a new message and never send outside the reply window", async () => {
    const p = { ...full, qualificationEnabled: true, followUpEnabled: true };
    const sender = "61477775555";
    await inbound("follow-start", { senderId: sender }, p);
    await worker.generateOne(p, approved);
    await inbound("follow-yes", { senderId: sender, body: "yes" }, p);
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_follow_up_requests",
        )
      ).rowCount,
    ).toBe(0);
    await worker.generateOne(p, approved);
    await inbound("follow-consent", { senderId: sender, body: "FOLLOW UP" }, p);
    await worker.generateOne(p, approved);
    await pool.query(
      "UPDATE sophia_runtime.assistant_follow_up_requests SET due_at=now()-interval '1 minute'",
    );
    expect(await worker.queueFollowUpOne(p)).toEqual({ processed: true });
    expect(await worker.queueFollowUpOne(p)).toEqual({ processed: false });
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE follow_up_request_id IS NOT NULL",
        )
      ).rowCount,
    ).toBe(1);
    await inbound(
      "follow-cancel",
      { senderId: sender, body: "Actually I have another question" },
      p,
    );
    expect(
      (
        await pool.query(
          "SELECT state FROM sophia_runtime.assistant_message_outbox WHERE follow_up_request_id IS NOT NULL",
        )
      ).rows[0].state,
    ).toBe("cancelled");
    await worker.generateOne(p, approved);
    await inbound(
      "follow-consent-expiry",
      { senderId: sender, body: "FOLLOW UP" },
      p,
    );
    await worker.generateOne(p, approved);
    await pool.query(
      "UPDATE sophia_runtime.assistant_follow_up_requests SET due_at=now()-interval '1 minute' WHERE state='scheduled'",
    );
    await pool.query(
      "UPDATE sophia_runtime.assistant_channel_contacts SET last_inbound_at=now()-interval '25 hours' WHERE sender_id=$1",
      [sender],
    );
    expect(await worker.queueFollowUpOne(p)).toEqual({ processed: true });
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE follow_up_request_id IS NOT NULL",
        )
      ).rowCount,
    ).toBe(1);
    // Dispatch independently rechecks the window after a reminder was queued.
    await inbound(
      "follow-consent-dispatch",
      { senderId: sender, body: "FOLLOW UP" },
      p,
    );
    await worker.generateOne(p, approved);
    await pool.query(
      "UPDATE sophia_runtime.assistant_follow_up_requests SET due_at=now()-interval '1 minute' WHERE state='scheduled'",
    );
    await worker.queueFollowUpOne(p);
    await pool.query(
      "UPDATE sophia_runtime.assistant_message_outbox SET state='cancelled' WHERE state='queued' AND follow_up_request_id IS NULL",
    );
    await pool.query(
      "UPDATE sophia_runtime.assistant_channel_contacts SET last_inbound_at=now()-interval '25 hours' WHERE sender_id=$1",
      [sender],
    );
    const send = jest.fn();
    await worker.dispatchOne(p, send);
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE follow_up_request_id IS NOT NULL AND state='queued'",
        )
      ).rowCount,
    ).toBe(0);
  });
  test("an eligible explicitly requested reminder is delivered once through the normal transport", async () => {
    const p = { ...full, qualificationEnabled: true, followUpEnabled: true };
    const sender = "61477775555";
    await inbound("follow-deliver", { senderId: sender, body: "FOLLOW UP" }, p);
    await worker.generateOne(p, approved);
    await pool.query(
      "UPDATE sophia_runtime.assistant_follow_up_requests SET due_at=now()-interval '1 minute' WHERE state='scheduled'",
    );
    await worker.queueFollowUpOne(p);
    await pool.query(
      "UPDATE sophia_runtime.assistant_message_outbox SET state='cancelled' WHERE state='queued' AND follow_up_request_id IS NULL",
    );
    const send = jest.fn().mockResolvedValue({
      kind: "accepted",
      providerMessageId: "wamid.follow-up-test",
    });
    await worker.dispatchOne(p, send);
    expect(send).toHaveBeenCalledTimes(1);
    await worker.dispatchOne(p, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT state FROM sophia_runtime.assistant_message_outbox WHERE provider_message_id='wamid.follow-up-test'",
        )
      ).rows[0].state,
    ).toBe("accepted");
  });
  test("offers assigned-advisor slots and books only after the customer's exact confirmation", async () => {
    process.env.WHATSAPP_BOOKING_ENABLED = "true";
    await appointments.saveCalendar(owner, company, advisor, {
      expectedRevision: 0,
      timezone: "Australia/Brisbane",
      slotMinutes: 30,
      leadTimeMinutes: 0,
      bookingWindowDays: 30,
      weeklyHours: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: "09:00",
        end: "12:00",
      })),
      closedDates: [],
    });
    const sender = "61422222222";
    await inbound("booking-request", {
      senderId: sender,
      body: "I want an appointment",
    });
    const bookingLead = (
      await pool.query(
        "SELECT l.lead_id FROM sophia_runtime.assistant_channel_contacts t JOIN sophia_runtime.assistant_leads l USING(customer_id,lead_id) WHERE t.customer_id=$1 AND t.sender_id=$2",
        [tenant, sender],
      )
    ).rows[0];
    let detail = await api.getLead(owner, company, bookingLead.lead_id);
    await api.updateLead(owner, company, bookingLead.lead_id, {
      expectedVersion: detail.lead.version,
      lead: input(advisor),
    });
    await pool.query(
      "UPDATE sophia_runtime.assistant_leads SET email='' WHERE lead_id=$1",
      [bookingLead.lead_id],
    );
    // Simulate a legacy provider label, not a staff/customer-confirmed name.
    await pool.query(
      "UPDATE sophia_runtime.assistant_lead_events SET metadata=metadata-'factsSource' WHERE conversation_id=(SELECT conversation_id FROM sophia_runtime.assistant_lead_conversations WHERE lead_id=$1) AND kind='lead_updated'",
      [bookingLead.lead_id],
    );
    detail = await api.getLead(owner, company, bookingLead.lead_id);
    await api.changeOwnership(owner, company, bookingLead.lead_id, {
      expectedVersion: detail.lead.ownershipVersion,
      ownership: "bot",
    });
    await inbound("undated-availability", {
      senderId: sender,
      body: "Could you show me the available times?",
    });
    await worker.generateOne(full, async () => ({
      handoff: true,
      answer: "",
      sourceIds: [],
    }));
    const recovered = (
      await pool.query(
        "SELECT state,answer,response_kind FROM sophia_runtime.assistant_reply_jobs WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(recovered.state).toBe("ready");
    expect(recovered.response_kind).toBe("appointment");
    expect(recovered.answer).toContain("fecha");
    expect(
      (await api.getLead(owner, company, bookingLead.lead_id)).lead.ownership,
    ).toBe("bot");
    await inbound("explicit-booking-after-recovery", {
      senderId: sender,
      body: "I want to do the appointment",
    });
    await worker.generateOne(full, async () => ({
      handoff: false,
      answer: "",
      sourceIds: [],
      booking: { action: "human_help" },
    }));
    const nextBooking = (
      await pool.query(
        "SELECT answer,response_kind FROM sophia_runtime.assistant_reply_jobs WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(nextBooking.response_kind).toBe("appointment");
    expect(nextBooking.answer).toContain("fecha");
    await inbound("dated-availability", {
      senderId: sender,
      body: "English course appointment in three days",
    });
    const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    expect(
      await worker.generateOne(full, async () => ({
        handoff: false,
        answer: "",
        sourceIds: [],
        booking: {
          action: "availability",
          date: day,
          timezone: "Pacific/Auckland",
          time: "13:00",
        },
      })),
    ).toEqual({ processed: true });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointments WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT response_kind FROM sophia_runtime.assistant_reply_jobs WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
          [bookingLead.lead_id],
        )
      ).rows[0].response_kind,
    ).toBe("appointment");
    const offeredSlots = (
      await pool.query(
        "SELECT slots FROM sophia_runtime.lead_appointment_offers WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0].slots;
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Pacific/Auckland",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(offeredSlots[0].startsAt)),
    ).toBe("13:00");
    await inbound("language-choice", {
      senderId: sender,
      body: "Quiero hablar en español",
    });
    await inbound("booking-selection", { senderId: sender, body: "1" });
    const namePrompt = (
      await pool.query(
        "SELECT body FROM sophia_runtime.assistant_message_outbox WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0].body;
    expect(namePrompt).toContain("NOMBRE");
    expect(namePrompt).not.toMatch(/CONFIRM \d{6}/);
    expect(
      (
        await pool.query(
          "SELECT language FROM sophia_runtime.assistant_leads WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].language,
    ).toBe("es");
    await inbound("booking-name", {
      senderId: sender,
      body: "NOMBRE José Muñoz",
    });
    expect(
      (
        await pool.query(
          "SELECT display_name FROM sophia_runtime.assistant_leads WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].display_name,
    ).toBe("José Muñoz");
    // Name alone permits confirmation; email remains optional.
    expect(
      (
        await pool.query(
          "SELECT status FROM sophia_runtime.lead_appointment_offers WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
          [bookingLead.lead_id],
        )
      ).rows[0].status,
    ).toBe("awaiting_confirmation");
    expect(
      (
        await pool.query(
          "SELECT email FROM sophia_runtime.assistant_leads WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].email,
    ).toBeFalsy();
    const confirmation = (
      await pool.query(
        "SELECT body FROM sophia_runtime.assistant_message_outbox WHERE lead_id=$1 AND body ILIKE '%CONFIRM %' ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0].body;
    const code = /CONFIRM (\d{6})/.exec(confirmation)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointments WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].count,
    ).toBe(0);
    await inbound("booking-wrong-confirm", {
      senderId: sender,
      body: "CONFIRM 000000",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointments WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].count,
    ).toBe(0);
    await inbound("booking-confirm", {
      senderId: sender,
      body: `CONFIRM ${code}`,
    });
    const saved = (
      await pool.query(
        "SELECT status,appointment_id,customer_timezone FROM sophia_runtime.lead_appointment_offers WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(saved).toMatchObject({
      status: "confirmed",
      customer_timezone: "Pacific/Auckland",
    });
    expect(saved.appointment_id).toBeTruthy();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointments WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].count,
    ).toBe(1);
    await inbound("booking-confirm-retry", {
      senderId: sender,
      body: `CONFIRM ${code}`,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointments WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].count,
    ).toBe(1);

    await inbound("booking-unknown-question", {
      senderId: sender,
      body: "What is an unlisted price?",
    });
    const unknown = jest.fn(async (context) => {
      expect(context.bookingContext.appointments).toHaveLength(1);
      expect(context.bookingContext.appointments[0].timezone).toBe(
        "Pacific/Auckland",
      );
      return {
        handoff: false,
        answer: "",
        sourceIds: [],
        booking: { action: "human_help" },
      };
    });
    await worker.generateOne(full, unknown);
    expect(unknown).toHaveBeenCalledTimes(1);
    const unknownJob = (
      await pool.query(
        "SELECT answer,state FROM sophia_runtime.assistant_reply_jobs WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(unknownJob.state).toBe("ready");
    expect(unknownJob.answer).toContain("tienes una cita");
    expect(
      (await api.getLead(owner, company, bookingLead.lead_id)).lead.ownership,
    ).toBe("bot");
    await inbound("booking-partial-question", {
      senderId: sender,
      body: "What is the exact English course price?",
    });
    await worker.generateOne(full, async () => ({
      ...(await approved()),
      answer: "No puedo confirmar el precio exacto.",
      needsTeam: true,
    }));
    const partialJob = (
      await pool.query(
        "SELECT answer,state FROM sophia_runtime.assistant_reply_jobs WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(partialJob.state).toBe("ready");
    expect(partialJob.answer).toContain("No puedo confirmar el precio exacto.");
    expect(partialJob.answer).toContain("otra pregunta");
    expect(partialJob.answer).not.toContain("tienes una cita");
    const original = (
      await pool.query(
        "SELECT starts_at,version,status FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
        [saved.appointment_id],
      )
    ).rows[0];
    const rescheduleDay = new Date(Date.now() + 4 * 86400000)
      .toISOString()
      .slice(0, 10);
    await inbound("reschedule-request", {
      senderId: sender,
      body: "Please reschedule my appointment",
    });
    await worker.generateOne(full, async () => ({
      handoff: false,
      answer: "",
      sourceIds: [],
      booking: {
        action: "reschedule",
        date: rescheduleDay,
        timezone: "Pacific/Auckland",
      },
    }));
    let change = (
      await pool.query(
        "SELECT * FROM sophia_runtime.lead_appointment_change_requests WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(change).toMatchObject({
      action: "reschedule",
      status: "offered",
      appointment_id: saved.appointment_id,
      expected_version: 1,
    });
    // Legacy bookings may have no confirmed name. A reschedule must repair it.
    await pool.query(
      "UPDATE sophia_runtime.assistant_lead_events SET metadata=metadata-'origin' WHERE conversation_id=(SELECT conversation_id FROM sophia_runtime.assistant_lead_conversations WHERE lead_id=$1) AND kind='lead_updated'",
      [bookingLead.lead_id],
    );
    await inbound("reschedule-selection", { senderId: sender, body: "1" });
    expect(
      (
        await pool.query(
          "SELECT status FROM sophia_runtime.lead_appointment_change_requests WHERE request_id=$1",
          [change.request_id],
        )
      ).rows[0].status,
    ).toBe("offered");
    expect(
      (
        await pool.query(
          "SELECT version FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
          [saved.appointment_id],
        )
      ).rows[0].version,
    ).toBe(1);
    await inbound("reschedule-name", {
      senderId: sender,
      body: "Me llamo José Muñoz",
    });

    const rescheduleConfirmation = (
      await pool.query(
        "SELECT body FROM sophia_runtime.assistant_message_outbox WHERE appointment_change_request_id=$1 AND body ILIKE '%CONFIRM %' ORDER BY created_at DESC LIMIT 1",
        [change.request_id],
      )
    ).rows[0].body;
    const rescheduleCode = /CONFIRM (\d{6})/.exec(rescheduleConfirmation)?.[1];
    expect(rescheduleCode).toMatch(/^\d{6}$/);
    expect(
      (
        await pool.query(
          "SELECT starts_at,version FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
          [saved.appointment_id],
        )
      ).rows[0],
    ).toEqual(
      expect.objectContaining({ version: 1, starts_at: original.starts_at }),
    );
    await inbound("reschedule-confirm", {
      senderId: sender,
      body: `CONFIRM ${rescheduleCode}`,
    });
    let changedAppointment = (
      await pool.query(
        "SELECT starts_at,version,status FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
        [saved.appointment_id],
      )
    ).rows[0];
    expect(changedAppointment.version).toBe(2);
    expect(changedAppointment.status).toBe("confirmed");
    expect(changedAppointment.starts_at.toISOString()).not.toBe(
      original.starts_at.toISOString(),
    );
    await inbound("reschedule-confirm-retry", {
      senderId: sender,
      body: `CONFIRM ${rescheduleCode}`,
    });
    expect(
      (
        await pool.query(
          "SELECT version FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
          [saved.appointment_id],
        )
      ).rows[0].version,
    ).toBe(2);

    await inbound("cancel-request", {
      senderId: sender,
      body: "Please cancel my appointment",
    });
    await worker.generateOne(full, async () => ({
      handoff: false,
      answer: "",
      sourceIds: [],
      booking: { action: "cancel" },
    }));
    change = (
      await pool.query(
        "SELECT * FROM sophia_runtime.lead_appointment_change_requests WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(change).toMatchObject({
      action: "cancel",
      status: "awaiting_confirmation",
      appointment_id: saved.appointment_id,
      expected_version: 2,
    });
    const cancelConfirmation = (
      await pool.query(
        "SELECT body FROM sophia_runtime.assistant_message_outbox WHERE appointment_change_request_id=$1 AND body ILIKE '%CONFIRM %' ORDER BY created_at DESC LIMIT 1",
        [change.request_id],
      )
    ).rows[0].body;
    const cancelCode = /CONFIRM (\d{6})/.exec(cancelConfirmation)?.[1];
    expect(cancelCode).toMatch(/^\d{6}$/);
    await inbound("cancel-wrong-confirm", {
      senderId: sender,
      body: "CONFIRM 000000",
    });
    expect(
      (
        await pool.query(
          "SELECT status,version FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
          [saved.appointment_id],
        )
      ).rows[0],
    ).toMatchObject({ status: "confirmed", version: 2 });
    await inbound("cancel-confirm", {
      senderId: sender,
      body: `CONFIRM ${cancelCode}`,
    });
    changedAppointment = (
      await pool.query(
        "SELECT status,version FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
        [saved.appointment_id],
      )
    ).rows[0];
    expect(changedAppointment).toMatchObject({
      status: "cancelled",
      version: 3,
    });
    await inbound("cancel-confirm-retry", {
      senderId: sender,
      body: `CONFIRM ${cancelCode}`,
    });
    expect(
      (
        await pool.query(
          "SELECT version FROM sophia_runtime.lead_appointments WHERE appointment_id=$1",
          [saved.appointment_id],
        )
      ).rows[0].version,
    ).toBe(3);

    const ambiguousAppointments = [];
    for (const offset of [5, 6]) {
      const appointmentDay = new Date(Date.now() + offset * 86400000)
        .toISOString()
        .slice(0, 10);
      const available = await appointments.availability(owner, company, {
        advisorId: advisor,
        date: appointmentDay,
        timezone: "Australia/Brisbane",
      });
      ambiguousAppointments.push(
        (
          await appointments.mutateAppointment(owner, company, "book", null, {
            requestKey: randomUUID(),
            leadId: bookingLead.lead_id,
            advisorId: advisor,
            startsAt: available.slots[0].startsAt,
            timezone: "Australia/Brisbane",
            calendarRevision: available.calendarRevision,
            description: "Ambiguity guard",
          })
        ).appointment,
      );
    }
    const requestCount = (
      await pool.query(
        "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointment_change_requests WHERE lead_id=$1",
        [bookingLead.lead_id],
      )
    ).rows[0].count;
    await inbound("ambiguous-cancel-request", {
      senderId: sender,
      body: "Cancel my appointment",
    });
    await worker.generateOne(full, async () => ({
      handoff: false,
      answer: "",
      sourceIds: [],
      booking: { action: "cancel" },
    }));
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointment_change_requests WHERE lead_id=$1",
          [bookingLead.lead_id],
        )
      ).rows[0].count,
    ).toBe(requestCount);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM sophia_runtime.lead_appointments WHERE lead_id=$1 AND status='confirmed'",
          [bookingLead.lead_id],
        )
      ).rows[0].count,
    ).toBe(2);

    await appointments.mutateAppointment(
      owner,
      company,
      "cancel",
      ambiguousAppointments[0].id,
      {
        requestKey: randomUUID(),
        leadId: bookingLead.lead_id,
        expectedVersion: ambiguousAppointments[0].version,
      },
    );
    const ownershipDay = new Date(Date.now() + 7 * 86400000)
      .toISOString()
      .slice(0, 10);
    await inbound("ownership-change-request", {
      senderId: sender,
      body: "Reschedule my appointment",
    });
    await worker.generateOne(full, async () => ({
      handoff: false,
      answer: "",
      sourceIds: [],
      booking: { action: "reschedule", date: ownershipDay },
    }));
    let ownershipRequest = (
      await pool.query(
        "SELECT request_id,status FROM sophia_runtime.lead_appointment_change_requests WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(ownershipRequest.status).toBe("offered");
    const additionalDay = new Date(Date.now() + 8 * 86400000)
      .toISOString()
      .slice(0, 10);
    const additionalAvailability = await appointments.availability(
      owner,
      company,
      {
        advisorId: advisor,
        date: additionalDay,
        timezone: "Australia/Brisbane",
      },
    );
    const additionalAppointment = (
      await appointments.mutateAppointment(owner, company, "book", null, {
        requestKey: randomUUID(),
        leadId: bookingLead.lead_id,
        advisorId: advisor,
        startsAt: additionalAvailability.slots[0].startsAt,
        timezone: "Australia/Brisbane",
        calendarRevision: additionalAvailability.calendarRevision,
        description: "Confirmation ambiguity guard",
      })
    ).appointment;
    await inbound("stale-reschedule-selection", {
      senderId: sender,
      body: "1",
    });
    expect(
      (
        await pool.query(
          "SELECT status FROM sophia_runtime.lead_appointment_change_requests WHERE request_id=$1",
          [ownershipRequest.request_id],
        )
      ).rows[0].status,
    ).toBe("expired");
    await appointments.mutateAppointment(
      owner,
      company,
      "cancel",
      additionalAppointment.id,
      {
        requestKey: randomUUID(),
        leadId: bookingLead.lead_id,
        expectedVersion: additionalAppointment.version,
      },
    );
    await inbound("ownership-change-request-two", {
      senderId: sender,
      body: "Reschedule my appointment",
    });
    await worker.generateOne(full, async () => ({
      handoff: false,
      answer: "",
      sourceIds: [],
      booking: { action: "reschedule", date: ownershipDay },
    }));
    ownershipRequest = (
      await pool.query(
        "SELECT request_id,status FROM sophia_runtime.lead_appointment_change_requests WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",
        [bookingLead.lead_id],
      )
    ).rows[0];
    expect(ownershipRequest.status).toBe("offered");
    detail = await api.getLead(owner, company, bookingLead.lead_id);
    await api.changeOwnership(owner, company, bookingLead.lead_id, {
      expectedVersion: detail.lead.ownershipVersion,
      ownership: "human",
    });
    expect(
      (
        await pool.query(
          "SELECT status FROM sophia_runtime.lead_appointment_change_requests WHERE request_id=$1",
          [ownershipRequest.request_id],
        )
      ).rows[0].status,
    ).toBe("cancelled");
  });
  test("offers realtime once after three questions and continues WhatsApp after refusal", async () => {
    const p = {
      ...full,
      qualificationEnabled: true,
      realtimeUrl: "https://example.test/sophia",
    };
    const sender = "61455550009";
    for (const [index, body] of [
      "What do you do?",
      "How can you help?",
      "What services?",
      "No thanks, stay on WhatsApp",
      "What else can you do?",
    ].entries()) {
      await inbound(`invite-${index}`, { senderId: sender, body }, p);
      await worker.generateOne(p, approved);
    }
    const jobs = (
      await pool.query(
        `SELECT j.answer,j.usage,j.state FROM sophia_runtime.assistant_reply_jobs j
      JOIN sophia_runtime.assistant_channel_contacts c USING(customer_id,lead_id)
      WHERE c.customer_id=$1 AND c.sender_id=$2 ORDER BY j.created_at`,
        [tenant, sender],
      )
    ).rows;
    expect(jobs).toHaveLength(5);
    expect(
      jobs.filter((j) => j.usage.engagement?.realtimeOffered),
    ).toHaveLength(1);
    expect(jobs[0].answer).not.toContain(p.realtimeUrl);
    expect(jobs[1].answer).not.toContain(p.realtimeUrl);
    expect(jobs[2].answer).toContain(p.realtimeUrl);
    expect(jobs[3].answer).not.toContain(p.realtimeUrl);
    expect(jobs[4].answer).not.toContain(p.realtimeUrl);
    // New customer messages supersede queued unsent replies, but every turn
    // was answered and the latest refusal-following answer remains ready.
    expect(
      jobs.every((j) => typeof j.answer === "string" && j.answer.length > 0),
    ).toBe(true);
    expect(jobs[4].state).toBe("ready");
  });
  test("knowledge retirement between generation and send cancels dispatch", async () => {
    await pool.query(
      "UPDATE sophia_runtime.knowledge_sources SET status='retired'",
    );
    const send = jest.fn();
    await worker.dispatchOne(full, send);
    expect(send).not.toHaveBeenCalled();
    await pool.query(
      "UPDATE sophia_runtime.knowledge_sources SET status='active'",
    );
  });
  test("fabricated citations fail closed; lack of approved knowledge routes to human assistance", async () => {
    await inbound("fake-cite", { senderId: "61477777777" });
    await worker.generateOne(full, async () => ({
      handoff: false,
      answer: "Invented",
      sourceIds: [randomUUID()],
    }));
    let row = (await api.listLeads(owner, company, {})).items.find(
      (i) => i.displayName === "Example" && i.ownership === "bot",
    );
    expect(row).toBeDefined();
    await pool.query("DELETE FROM sophia_runtime.knowledge_snapshot_grants");
    await inbound("no-sources", { senderId: "61466666666" });
    const reason = jest.fn();
    await worker.generateOne(full, reason);
    expect(reason).not.toHaveBeenCalled();
  });
  test("newer customer messages supersede an in-flight automatic answer and resume remains explicit", async () => {
    await pool.query(
      "INSERT INTO sophia_runtime.knowledge_snapshot_grants VALUES($1,$2,$3)",
      [tenant, snapshot, capability],
    );
    await inbound("supersede-first", { senderId: "61455555555" });
    await worker.generateOne(full, async () => {
      await inbound("supersede-next", { senderId: "61455555555" });
      return approved();
    });
    const row = (await api.listLeads(owner, company, {})).items.find(
      (i) => i.ownership === "bot",
    );
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_message_outbox WHERE lead_id=$1 AND state='queued'",
          [row.leadId],
        )
      ).rowCount,
    ).toBe(0);
    await worker.generateOne(full, approved);
    const d = await api.getLead(owner, company, row.leadId);
    await api.changeOwnership(owner, company, row.leadId, {
      expectedVersion: d.lead.ownershipVersion,
      ownership: "human",
    });
    const taken = await api.getLead(owner, company, row.leadId);
    expect(taken.reply.canResume).toBe(true);
    await api.changeOwnership(owner, company, row.leadId, {
      expectedVersion: taken.lead.ownershipVersion,
      ownership: "bot",
    });
    expect((await api.getLead(owner, company, row.leadId)).lead.ownership).toBe(
      "bot",
    );
    await pool.query(
      "UPDATE sophia_runtime.assistant_reply_jobs SET state='cancelled' WHERE state='queued'",
    );
  });
  test("expired dispatch leases become uncertain instead of replaying; concurrent workers dispatch once", async () => {
    await queue();
    await pool.query(
      "UPDATE sophia_runtime.assistant_message_outbox SET state='dispatching',dispatch_id=$1,dispatch_until=now()-interval '1 minute' WHERE state='queued'",
      [randomUUID()],
    );
    const send = jest.fn().mockResolvedValue({
      kind: "accepted",
      providerMessageId: "wamid.concurrent",
    });
    await worker.dispatchOne(full, send);
    expect(send).not.toHaveBeenCalled();
    await queue();
    await Promise.all([
      worker.dispatchOne(full, send),
      worker.dispatchOne(full, send),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("a cross-tenant release cannot be attached and source-event tenant references are enforced", async () => {
    const otherRelease = randomUUID();
    await pool.query(
      "INSERT INTO sophia_runtime.agent_release_manifests VALUES($1,$2,$3,$4,'sophia-safety-1',1)",
      [
        otherRelease,
        randomUUID(),
        otherTenant,
        { schemaVersion: 1, tenantId: otherTenant, configuration: {} },
      ],
    );
    await expect(
      replies.bindResponse(owner, company, {
        profileId: profile.id,
        releaseId: otherRelease,
        mode: "automatic",
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const d = await api.getLead(owner, company, lead.leadId);
    await expect(
      pool.query(
        "INSERT INTO sophia_runtime.assistant_reply_jobs(customer_id,channel_id,lead_id,conversation_id,source_event_id,agent_release_id,ownership_version) SELECT $1,t.channel_id,$2,$3,999999,$4,1 FROM sophia_runtime.assistant_channel_contacts t WHERE t.customer_id=$1 AND t.lead_id=$2",
        [tenant, lead.leadId, d.lead.conversationId, release],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  test("late inbound deliveries do not supersede the latest customer question", async () => {
    await inbound("ordered-recent", {
      senderId: "61444444444",
      body: "English course price",
    });
    await inbound("ordered-old", {
      senderId: "61444444444",
      body: "Old question",
      sentAt: new Date(Date.now() - 86400000).toISOString(),
    });
    const reason = jest.fn(approved);
    await worker.generateOne(full, reason);
    expect(reason.mock.calls[0][0].question).toBe("English course price");
  });
  test("retired reasoning configuration hands an automatic enquiry to the team without a model request", async () => {
    await pool.query(
      "UPDATE sophia_runtime.provider_configurations SET status='retired'",
    );
    await inbound("provider-retired", { senderId: "61433333333" });
    const reason = jest.fn();
    await worker.generateOne(full, reason);
    expect(reason).not.toHaveBeenCalled();
    const job = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_reply_jobs ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    expect(job.state).toBe("needs_human");
    expect(
      (await api.getLead(owner, company, job.lead_id)).lead.ownership,
    ).toBe("bot");
    const send = jest.fn(async () => ({
      kind: "accepted",
      providerMessageId: randomUUID(),
    }));
    for (let i = 0; i < 8; i++) await worker.dispatchOne(full, send);
    expect(
      send.mock.calls.some(([, m]) => m.body === worker.handoffNotice("es")),
    ).toBe(true);
  });
  test("queued replies are cancelled when the sender loses current authority", async () => {
    await queue();
    await pool.query(
      "UPDATE sophia_runtime.admin_memberships SET status='inactive' WHERE identity_user_id=$1",
      [owner],
    );
    const send = jest.fn();
    await worker.dispatchOne(full, send);
    expect(send).not.toHaveBeenCalled();
    await pool.query(
      "UPDATE sophia_runtime.admin_memberships SET status='active' WHERE identity_user_id=$1",
      [owner],
    );
  });
  test("changing reply policy hands existing automated conversations back to the team", async () => {
    await replies.bindResponse(owner, company, {
      profileId: profile.id,
      releaseId: release,
      mode: "review",
      expectedRevision: 3,
    });
    expect(
      (
        await pool.query(
          "SELECT * FROM sophia_runtime.assistant_lead_conversations WHERE ownership='bot'",
        )
      ).rowCount,
    ).toBe(0);
  });
});
