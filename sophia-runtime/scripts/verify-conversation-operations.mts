import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ConversationAdminService } from "../src/admin/conversations/conversation-admin.service.js";

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const sessionId = randomUUID();
const otherSessionId = randomUUID();
const marker = `conversation-probe-${randomUUID()}`;
const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO ${schema}.customers (customer_id, name) VALUES ($1, 'conversation-probe'), ($2, 'other-probe')`,
    [tenantId, otherTenantId]);
  await client.query(
    `INSERT INTO ${schema}.sessions
      (session_id, customer_id, ai_provider, avatar_provider, status, ended_at)
     VALUES ($1, $2, 'probe', 'none', 'closed', now()), ($3, $4, 'probe', 'none', 'closed', now())`,
    [sessionId, tenantId, otherSessionId, otherTenantId]);
  await client.query(
    `INSERT INTO ${schema}.session_privacy_controls (session_id, customer_id) VALUES ($1, $2), ($3, $4)`,
    [sessionId, tenantId, otherSessionId, otherTenantId]);
  await client.query(
    `INSERT INTO ${schema}.events (session_id, customer_id, event_type, payload)
     VALUES ($1, $2, 'probe.message', $3::jsonb)`, [sessionId, tenantId, JSON.stringify({ text: marker, apiKey: "secret" })]);
  await client.query(
    `INSERT INTO ${schema}.conversation_operator_notes (customer_id, session_id, note_text, created_by_identity)
     VALUES ($1, $2, $3, 'probe-operator')`, [tenantId, sessionId, marker]);

  await client.query("SET ROLE sophia_runtime_app");
  const database = {
    tenantTransaction: async <T>(requestedTenantId: string, work: (transactionClient: Client) => Promise<T>) => {
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [requestedTenantId]);
      return work(client);
    },
  };
  const service = new ConversationAdminService(database as never, { record: async () => undefined } as never);
  const list = await service.list(tenantId, { limit: 10 });
  const detail = await service.detail(tenantId, sessionId);
  const content = await service.content(tenantId, sessionId);
  const crossTenant = await service.list(otherTenantId, { limit: 10 });
  const metadataExport = await service.createExport(tenantId, sessionId, "probe-operator",
    { format: "json", scope: "metadata", maxItems: 100 }, false);
  let contentExportDenied = false;
  try {
    await service.createExport(tenantId, sessionId, "metadata-only-operator",
      { format: "json", scope: "content", maxItems: 100 }, false);
  } catch { contentExportDenied = true; }
  const contentExport = await service.createExport(tenantId, sessionId, "probe-operator",
    { format: "json", scope: "content", maxItems: 100 }, true);
  const metadataDownload = await service.downloadExport(tenantId,
    metadataExport.conversation_export_job_id, "probe-operator", false);
  const contentDownload = await service.downloadExport(tenantId,
    contentExport.conversation_export_job_id, "probe-operator", true);
  const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
     WHERE relnamespace = $1::regnamespace AND relname = ANY($2::text[])`,
    [schema, ["conversation_operator_notes", "conversation_export_jobs"]]);
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'conversation_export_jobs'`,
    [schema]);
  const metadataText = JSON.stringify(detail);
  const contentText = JSON.stringify(content);
  console.log(JSON.stringify({
    tenantListCount: list.conversations.length,
    crossTenantListCount: crossTenant.conversations.length,
    tenantIsolation: list.conversations.every((row) => row.session_id === sessionId)
      && crossTenant.conversations.every((row) => row.session_id === otherSessionId),
    metadataWithheldMarker: !metadataText.includes(marker),
    contentContainsMarker: contentText.includes(marker),
    contentCredentialRedacted: contentText.includes("[REDACTED]") && !contentText.includes("secret"),
    transcriptStatus: content.transcript.status,
    audioStatus: content.audio.status,
    contentExportDenied,
    metadataExportWithheldMarker: !JSON.stringify(metadataDownload.document).includes(marker),
    contentExportContainsMarker: JSON.stringify(contentDownload.document).includes(marker),
    exportDigestPresent: /^[a-f0-9]{64}$/.test(contentDownload.digest),
    noStoredExportDocument: !columns.rows.some((row) => ["document", "content", "payload"].includes(row.column_name)),
    operationTablesForcedRls: flags.rows.length === 2
      && flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    transaction: "rolled_back",
  }));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
