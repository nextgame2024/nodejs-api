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
const url = process.env.LOCAL_WHATSAPP_VOICE_TEST_DATABASE_URL;
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
const voice = await import("../src/services/messaging/voice-worker.js");
const voiceApi = await import("../src/services/messaging/voice-api.service.js");
const worker = await import("../src/services/messaging/reply-worker.js");
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
  });
  beforeAll(async () => {
    await pool.query(
      (
        await readFile(
          new URL(
            "../sophia-runtime/src/database/migrations/120_whatsapp_voice_pipeline.sql",
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
    voiceEnabled: true,
    mediaKeyEnv: "WHATSAPP_TEST_MEDIA_KEY",
    transcriptionAdapter: "test-stt",
    transcriptionCredentialRef: "env://test-stt",
    synthesisAdapter: "test-tts",
    synthesisCredentialRef: "env://test-tts",

    reasoningAdapter: "test",
    reasoningCredentialRef: "env://test",
  };
  const full = { ...profile, ready: true, accessToken: "local-test-token" };
  const inbound = async (id, extra = {}) => {
    await channel.receiveEvents(full, [
      {
        key: "message:" + id,
        kind: "inbound",
        messageId: id,
        senderId: "61412345678",
        body: "English course price",
        messageType: "text",
        displayName: "Example",
        sentAt: new Date().toISOString(),
        ...extra,
      },
    ]);
    await channel.processChannelEvent(full);
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

  test("enables approved speech capabilities without affecting text defaults", async () => {
    process.env.WHATSAPP_TEST_MEDIA_KEY = "ab".repeat(32);
    process.env.WHATSAPP_VOICE_ENABLED = "true";
    for (const [adapter, cap] of [
      ["test-stt", "speech-input"],
      ["test-tts", "speech-output"],
    ]) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO sophia_runtime.provider_configurations VALUES($1,$2,'published',$3,$4,'{}')",
        [id, tenant, adapter, "env://" + adapter],
      );
      await pool.query(
        "INSERT INTO sophia_runtime.experience_provider_bindings VALUES($1,$2,$3)",
        [business, id, cap],
      );
    }
    await takeover();
  });
  const synth = {
    synthesize: async () => Buffer.alloc(4800, 1),
    encode: async () => Buffer.from("OggS test voice"),
  };
  test("pairs text and voice; failed generation retries only voice, never text", async () => {
    await queue();
    let rows = (
      await pool.query(
        "SELECT * FROM sophia_runtime.assistant_message_outbox ORDER BY format DESC",
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.format === "text").body).toContain(
      "generada por IA",
    );
    await voice.synthesizeOne(full, {
      ...synth,
      synthesize: async () => {
        throw Error("private provider error");
      },
    });
    await worker.dispatchOne(full, async () => ({
      kind: "accepted",
      providerMessageId: "text-accepted",
    }));
    let d = await api.getLead(owner, company, lead.leadId);
    expect(d.reply.voiceJobs[0].canRetry).toBe(true);
    await voiceApi.retryVoice(
      owner,
      company,
      lead.leadId,
      d.reply.voiceJobs[0].id,
    );
    await voice.synthesizeOne(full, synth);
    let asset = (
      await pool.query("SELECT * FROM sophia_runtime.assistant_voice_assets")
    ).rows[0];
    expect(asset.ciphertext.toString()).not.toContain("OggS");
    let calls = 0;
    await worker.dispatchOne(
      full,
      async (p, m) => {
        calls++;
        expect(m.mediaId).toBe("media-ok");
        return { kind: "accepted", providerMessageId: "voice-accepted" };
      },
      {
        prepareAudio: (p, m) =>
          voice.prepareVoiceMedia(p, m, async () => "media-ok"),
      },
    );
    expect(calls).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.assistant_message_outbox WHERE format='text'",
        )
      ).rows[0].n,
    ).toBe(1);
    asset = (
      await pool.query("SELECT * FROM sophia_runtime.assistant_voice_assets")
    ).rows[0];
    expect(asset.ciphertext).toBeNull();
  });
  test("audio receipt queues a read-only transcription and appends the transcript once", async () => {
    await inbound("voice-in", {
      messageType: "audio",
      body: "",
      media: { id: "audio1", voice: true },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.assistant_voice_jobs WHERE kind='transcribe'",
        )
      ).rows[0].n,
    ).toBe(1);
    await voice.transcribeOne(full, {
      download: async () => ({
        bytes: Buffer.alloc(10),
        mimeType: "audio/ogg",
      }),
      decode: async () => Buffer.alloc(4800, 1),
      transcribe: async () => "English course price",
    });
    expect(
      (
        await pool.query(
          "SELECT body FROM sophia_runtime.assistant_lead_events WHERE metadata ? 'transcriptOf'",
        )
      ).rows,
    ).toEqual([{ body: "English course price" }]);
    expect((await voice.transcribeOne(full, {})).processed).toBe(false);
  });

  test("never resends uncertain audio, and expired encrypted media is purged", async () => {
    await queue(randomUUID(), "Second answer");
    await voice.synthesizeOne(full, synth);
    await worker.dispatchOne(full, async () => ({
      kind: "accepted",
      providerMessageId: "second-text",
    }));
    await worker.dispatchOne(
      full,
      async () => ({ kind: "unknown", code: "send_unconfirmed" }),
      {
        prepareAudio: (p, m) =>
          voice.prepareVoiceMedia(p, m, async () => "second-media"),
      },
    );
    const d = await api.getLead(owner, company, lead.leadId);
    const job = d.reply.voiceJobs.find(
      (j) => j.kind === "synthesize" && j.state === "ready",
    );
    await expect(
      voiceApi.retryVoice(owner, company, lead.leadId, job.id),
    ).rejects.toMatchObject({ status: 409 });
    const send = jest.fn();
    await worker.dispatchOne(full, send);
    expect(send).not.toHaveBeenCalled();
    await queue(randomUUID(), "Expiry test");
    await voice.synthesizeOne(full, synth);
    await pool.query(
      "UPDATE sophia_runtime.assistant_voice_assets SET expires_at=now()-interval '1 second'",
    );
    await voice.expireVoiceAssets(full);
    expect(
      (
        await pool.query(
          "SELECT ciphertext FROM sophia_runtime.assistant_voice_assets",
        )
      ).rows.every((a) => a.ciphertext === null),
    ).toBe(true);
  });
  test("cancels voice generation after ownership changes during provider work", async () => {
    await queue(randomUUID(), "Cancelled answer");
    await voice.synthesizeOne(full, {
      ...synth,
      synthesize: async () => {
        const d = await api.getLead(owner, company, lead.leadId);
        await api.changeOwnership(owner, company, lead.leadId, {
          expectedVersion: d.lead.ownershipVersion,
          ownership: "paused",
        });
        return Buffer.alloc(4800, 1);
      },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM sophia_runtime.assistant_message_outbox WHERE body='Cancelled answer' AND state='cancelled'",
        )
      ).rows[0].n,
    ).toBe(1);
    await takeover();
  });
  test("retired speech providers block dispatch after generation", async () => {
    await queue(randomUUID(), "Revoked speech answer");
    await voice.synthesizeOne(full, synth);
    await worker.dispatchOne(full, async () => ({
      kind: "accepted",
      providerMessageId: "revoked-text",
    }));
    await pool.query(
      "UPDATE sophia_runtime.provider_configurations SET status='retired' WHERE adapter_key='test-tts'",
    );
    const send = jest.fn();
    await worker.dispatchOne(full, send, {
      prepareAudio: async () => "must-not-upload",
    });
    expect(send).not.toHaveBeenCalled();
    await pool.query(
      "UPDATE sophia_runtime.provider_configurations SET status='published' WHERE adapter_key='test-tts'",
    );
  });
  test("failed automatic transcription asks for text once and hands off safely", async () => {
    process.env.WHATSAPP_AUTOMATION_ENABLED = "true";
    await pool.query(
      "UPDATE sophia_runtime.assistant_reply_bindings SET mode='automatic'",
    );
    const d = await api.getLead(owner, company, lead.leadId);
    await api.changeOwnership(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
      ownership: "bot",
    });
    await inbound("broken-voice", {
      messageType: "audio",
      body: "",
      media: { id: "broken" },
    });
    await voice.transcribeOne(full, {
      download: async () => {
        throw Error("private transport detail");
      },
    });
    const messages = [];
    await worker.dispatchOne(full, async (p, m) => {
      messages.push(m.body);
      return { kind: "accepted", providerMessageId: "fallback" };
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("escribe tu pregunta");
    expect(
      (await api.getLead(owner, company, lead.leadId)).lead.ownership,
    ).toBe("human_requested");
    const again = jest.fn();
    await worker.dispatchOne(full, again);
    expect(again).not.toHaveBeenCalled();
  });
  test("a new automatic voice enquiry uses the grounded text-answer path and creates both formats", async () => {
    await inbound("automatic-voice", {
      senderId: "61499999999",
      messageType: "audio",
      body: "",
      media: { id: "newaudio" },
    });
    await voice.transcribeOne(full, {
      download: async () => ({
        bytes: Buffer.alloc(10),
        mimeType: "audio/ogg",
      }),
      decode: async () => Buffer.alloc(4800, 1),
      transcribe: async () => "English course price",
    });
    await worker.generateOne(full, approved);
    const other = (
      await pool.query(
        "SELECT lead_id FROM sophia_runtime.assistant_channel_contacts WHERE sender_id='61499999999'",
      )
    ).rows[0].lead_id;
    const messages = (
      await pool.query(
        "SELECT format,body FROM sophia_runtime.assistant_message_outbox WHERE lead_id=$1",
        [other],
      )
    ).rows;
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.format === "audio").body).toBe(
      "The English course costs AUD 100.",
    );
    const d = await api.getLead(owner, company, other);
    expect(d.lead.ownership).toBe("bot");
    await api.changeOwnership(owner, company, other, {
      expectedVersion: d.lead.ownershipVersion,
      ownership: "human",
    });
  });
  test("a delayed transcript cannot supersede a newer message sent in the same second", async () => {
    const stamp = new Date().toISOString();
    await inbound("tie-voice", {
      messageType: "audio",
      body: "",
      media: { id: "tieaudio" },
      sentAt: stamp,
    });
    await inbound("tie-text", {
      messageType: "text",
      body: "Newer question",
      sentAt: stamp,
    });
    await voice.transcribeOne(full, {
      download: async () => ({
        bytes: Buffer.alloc(10),
        mimeType: "audio/ogg",
      }),
      decode: async () => Buffer.alloc(4800, 1),
      transcribe: async () => "Older spoken question",
    });
    const d = await takeover();
    await replies.draftReply(owner, company, lead.leadId, {
      expectedVersion: d.lead.ownershipVersion,
    });
    const row = (
      await pool.query(
        "SELECT e.body FROM sophia_runtime.assistant_reply_jobs j JOIN sophia_runtime.assistant_lead_events e ON e.event_id=j.source_event_id WHERE j.lead_id=$1 AND j.state='queued'",
        [lead.leadId],
      )
    ).rows;
    expect(row.map((r) => r.body)).toEqual(["Newer question"]);
  });
  test("persists maximum-length text plus the AI voice disclosure after acceptance", async () => {
    await takeover();
    await queue(randomUUID(), "X".repeat(4000));
    await worker.dispatchOne(full, async () => ({
      kind: "accepted",
      providerMessageId: "max-length-text",
    }));
    const row = (
      await pool.query(
        "SELECT body FROM sophia_runtime.assistant_lead_events WHERE metadata->>'messageId'='max-length-text'",
      )
    ).rows[0];
    expect(row.body.length).toBeGreaterThan(4000);
    expect(row.body.length).toBeLessThanOrEqual(4096);
  });
  test("spoken opt out pauses automation", async () => {
    await inbound("voice-stop", {
      messageType: "audio",
      body: "",
      media: { id: "audio2" },
    });
    await voice.transcribeOne(full, {
      download: async () => ({
        bytes: Buffer.alloc(10),
        mimeType: "audio/ogg",
      }),
      decode: async () => Buffer.alloc(4800, 1),
      transcribe: async () => "STOP",
    });
    expect(
      (await api.getLead(owner, company, lead.leadId)).reply.optedOut,
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT ownership FROM sophia_runtime.assistant_lead_conversations WHERE lead_id=$1",
          [lead.leadId],
        )
      ).rows[0].ownership,
    ).toBe("paused");
  });
  test("enforces FORCE RLS and does not grant runtime deletion of voice storage", async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE sophia_runtime_app");
      await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
        otherTenant,
      ]);
      expect(
        (await db.query("SELECT * FROM sophia_runtime.assistant_voice_jobs"))
          .rows,
      ).toHaveLength(0);
      await expect(
        db.query("DELETE FROM sophia_runtime.assistant_voice_assets"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  });
});
