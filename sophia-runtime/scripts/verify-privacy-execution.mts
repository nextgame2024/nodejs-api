import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PrivacyExecutionService } from "../src/admin/privacy/privacy-execution.service.js";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

const tenantId = randomUUID();
const sessionId = randomUUID();
const requestId = randomUUID();
const commandId = randomUUID();
const policyId = randomUUID();
const subjectDigest = "a".repeat(64);
const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${schema}.customers (customer_id, name) VALUES ($1, 'privacy-execution-probe')`, [tenantId]);
  await client.query(
    `INSERT INTO ${schema}.sessions
      (session_id, customer_id, ai_provider, avatar_provider, status, metadata, ended_at)
     VALUES ($1, $2, 'none', 'none', 'closed', '{"email":"synthetic@example.invalid","sessionAccessTokenHash":"secret"}'::jsonb,
       now() - interval '90 days')`, [sessionId, tenantId]);
  await client.query(
    `INSERT INTO ${schema}.tool_calls
      (session_id, customer_id, tool_name, status, input, output, invocation_id, accepted_at, policy_decision)
     VALUES ($1, $2, 'probe.tool', 'succeeded', '{"email":"synthetic@example.invalid"}'::jsonb,
       '{"name":"Synthetic Person"}'::jsonb, $3, now(), 'allowed')`, [sessionId, tenantId, randomUUID()]);
  await client.query(
    `INSERT INTO ${schema}.events (session_id, customer_id, event_type, payload)
     VALUES ($1, $2, 'probe.personal', '{"email":"synthetic@example.invalid"}'::jsonb)`, [sessionId, tenantId]);
  await client.query(
    `INSERT INTO ${schema}.action_reviews
      (review_id, session_id, customer_id, action_type, payload, payload_hash, status, command_id, expires_at, committed_at)
     VALUES ($1, $2, $3, 'probe.action', '{"email":"synthetic@example.invalid"}'::jsonb,
       'synthetic', 'committed', $4, now() + interval '1 day', now())`, [randomUUID(), sessionId, tenantId, commandId]);
  await client.query(
    `INSERT INTO ${schema}.privacy_subject_requests
      (privacy_subject_request_id, customer_id, request_type, subject_reference_digest, selectors,
       verification_status, verification_method, verification_evidence_reference, status,
       requested_by_identity, verified_by_identity, verified_at)
     VALUES ($1,$2,'deletion',$3,$4::jsonb,'verified','documented_manual_check','probe:verified','ready','probe','probe',now())`,
    [requestId, tenantId, subjectDigest, JSON.stringify({ sessionIds: [sessionId] })]);
  for (const [targetKey, ownership] of [
    ["runtime_session_content", "runtime_controlled"], ["runtime_review_payloads", "runtime_controlled"],
    ["runtime_operational_metadata", "runtime_controlled"], ["business_manager_documents", "external_owner"],
    ["provider_owned_data", "external_owner"], ["backups", "external_owner"],
  ]) await client.query(
    `INSERT INTO ${schema}.privacy_subject_request_targets
      (customer_id, privacy_subject_request_id, target_key, ownership) VALUES ($1,$2,$3,$4)`,
    [tenantId, requestId, targetKey, ownership]);
  await client.query(
    `INSERT INTO ${schema}.privacy_subject_bindings
      (customer_id, subject_reference_digest, session_id, created_by_request_id) VALUES ($1,$2,$3,$4)`,
    [tenantId, subjectDigest, sessionId, requestId]);

  await client.query("SET ROLE sophia_runtime_app");
  const database = {
    tenantTransaction: async <T>(requestedTenantId: string, work: (transactionClient: Client) => Promise<T>) => {
      if (requestedTenantId !== tenantId) throw new Error("Probe tenant mismatch.");
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [requestedTenantId]);
      return work(client);
    },
  };
  const businessManager = {
    redactPrivacySubjectData: async (commands: string[]) => ({
      status: "completed" as const,
      counts: { bookingsRedacted: commands.length, emailCommandsRedacted: 0, deliveriesRedacted: 0 },
      digestAlgorithm: "sha256" as const,
      digest: "b".repeat(64),
    }),
  };
  const service = new PrivacyExecutionService(database as never, businessManager as never);
  const first = await service.execute(tenantId, requestId, "probe-operator");
  if (first.status !== "blocked") throw new Error("Backups must keep the request blocked before owner evidence.");
  const completed = await service.recordExternalEvidence(tenantId, requestId, "backups", "probe-operator", {
    status: "not_applicable",
    evidenceReference: "probe:no-backup-created",
    evidenceDigest: "c".repeat(64),
    detail: "The rollback-only synthetic record was never committed to backup storage.",
  });
  if (completed.status !== "completed") throw new Error("The synthetic request did not complete after all targets were verified.");

  const redaction = await client.query<{
    session_private: boolean; tool_private: boolean; event_private: boolean; review_private: boolean;
  }>(`SELECT
      EXISTS (SELECT 1 FROM ${schema}.sessions WHERE session_id = $1
        AND metadata::text ILIKE '%synthetic@example.invalid%') AS session_private,
      EXISTS (SELECT 1 FROM ${schema}.tool_calls WHERE session_id = $1
        AND (input::text ILIKE '%synthetic@example.invalid%' OR output::text ILIKE '%Synthetic Person%')) AS tool_private,
      EXISTS (SELECT 1 FROM ${schema}.events WHERE session_id = $1
        AND payload::text ILIKE '%synthetic@example.invalid%') AS event_private,
      EXISTS (SELECT 1 FROM ${schema}.action_reviews WHERE session_id = $1 AND payload <> '{}'::jsonb) AS review_private`, [sessionId]);

  await client.query(
    `INSERT INTO ${schema}.privacy_retention_policies
      (privacy_retention_policy_id, customer_id, dataset_key, version, status, retention_days,
       disposal_method, policy_reference, created_by_identity, approved_by_identity, approved_at)
     VALUES ($1,$2,'session_content',1,'approved',30,'deidentify','probe:approved-policy','probe','independent-reviewer',now())`,
    [policyId, tenantId]);
  await client.query(
    `INSERT INTO ${schema}.privacy_legal_holds
      (customer_id, subject_reference_digest, reason_reference, created_by_identity)
     VALUES ($1,$2,'probe:active-hold','probe')`, [tenantId, subjectDigest]);
  const retention = await service.retentionRun(tenantId, "probe-operator", {
    privacyRetentionPolicyId: policyId, execute: true, limit: 100,
  });
  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relnamespace = $1::regnamespace AND relname = ANY($2::text[])`,
    [schema, ["privacy_subject_bindings", "privacy_subject_request_events", "privacy_retention_runs"]]);
  const privateDataAbsent = Object.values(redaction.rows[0]).every((value) => value === false);
  console.log(JSON.stringify({
    requestCompleted: completed.status === "completed",
    privateDataAbsent,
    retentionHeldCount: retention.heldCount,
    retentionProcessedCount: retention.processedCount,
    allExecutionTablesForcedRls: flags.rows.length === 3
      && flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    transaction: "rolled_back",
  }));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
