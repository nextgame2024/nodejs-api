import { randomUUID } from "node:crypto";
import { Client } from "pg";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
const tenantA = randomUUID();
const tenantB = randomUUID();
const sessionId = randomUUID();
const privacyTables = [
  "privacy_notice_versions", "privacy_consent_events", "session_privacy_controls",
  "privacy_retention_policies", "privacy_legal_holds", "privacy_subject_requests",
  "privacy_subject_request_targets", "privacy_data_flows", "privacy_legal_reviews",
];

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO ${schema}.customers (customer_id, name) VALUES ($1, 'privacy-probe-a'), ($2, 'privacy-probe-b')`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO ${schema}.sessions
      (session_id, customer_id, ai_provider, avatar_provider, status)
     VALUES ($1, $2, 'probe', 'none', 'closed')`,
    [sessionId, tenantA],
  );
  await client.query(
    `INSERT INTO ${schema}.session_privacy_controls (session_id, customer_id) VALUES ($1, $2)`,
    [sessionId, tenantA],
  );
  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity
     FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind = 'r'
       AND relname = ANY($2::text[]) ORDER BY relname`,
    [schema, privacyTables],
  );
  await client.query("SET ROLE sophia_runtime_app");
  await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenantA]);
  const inserted = await client.query(
    `INSERT INTO ${schema}.privacy_subject_requests
      (customer_id, request_type, subject_reference_digest, selectors, requested_by_identity)
     VALUES ($1, 'deletion', $2, '{"sessionIds":[]}'::jsonb, 'probe')
     RETURNING privacy_subject_request_id`,
    [tenantA, "a".repeat(64)],
  );
  const crossTenantDenied = await expectFailure("cross_tenant", () => client.query(
    `INSERT INTO ${schema}.privacy_subject_requests
      (customer_id, request_type, subject_reference_digest, selectors, requested_by_identity)
     VALUES ($1, 'deletion', $2, '{}'::jsonb, 'probe')`,
    [tenantB, "b".repeat(64)],
  ));
  const privacyOff = await client.query<{ all_off: boolean | null }>(
    `SELECT bool_and(NOT raw_audio_recording_enabled
      AND NOT full_transcript_persistence_enabled AND NOT marketing_enabled) AS all_off
     FROM ${schema}.session_privacy_controls`,
  );
  const recordingEnableDenied = await expectFailure("enable_recording", () => client.query(
    `UPDATE ${schema}.session_privacy_controls SET raw_audio_recording_enabled = true WHERE customer_id = $1`,
    [tenantA],
  ));
  console.log(JSON.stringify({
    privacyTables: flags.rows.length,
    allPrivacyTablesForcedRls: flags.rows.length === privacyTables.length
      && flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    runtimeRoleInsert: Boolean(inserted.rows[0]),
    crossTenantDenied,
    existingPrivacyDefaultsOff: privacyOff.rows[0]?.all_off !== false,
    recordingEnableDenied,
    transaction: "rolled_back",
  }));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}

async function expectFailure(name: string, operation: () => Promise<unknown>): Promise<boolean> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await operation();
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return false;
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return true;
  }
}
