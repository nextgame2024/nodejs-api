import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService, sanitizeAuditMetadata } from "../authorization/admin-audit.service.js";
import { AuditFiltersSchema, AuditListQuerySchema, CreateAuditExportSchema } from "./audit.contracts.js";

type Filters = ReturnType<typeof AuditFiltersSchema.parse>;

@Injectable()
export class AuditExplorerService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async list(tenantId: string, query: unknown) {
    const parsed = AuditListQuerySchema.parse(query); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const { sql, params } = filterSql(parsed, tenantId, undefined, parsed.before && parsed.beforeId
        ? { createdAt: parsed.before, eventId: parsed.beforeId } : undefined);
      const result = await client.query(
        `SELECT audit_event_id, identity_user_id, event_type, resource_type, resource_id,
                permission_key, outcome, correlation_id, metadata, created_at
         FROM ${schema}.admin_audit_events ${sql}
         ORDER BY created_at DESC, audit_event_id DESC LIMIT $${params.length + 1}`,
        [...params, parsed.limit + 1],
      );
      const hasMore = result.rows.length > parsed.limit;
      const events = result.rows.slice(0, parsed.limit).map(safeEvent);
      const last = hasMore ? events.at(-1) : undefined;
      return { events, hasMore, nextCursor: last ? { before: last.created_at, beforeId: last.audit_event_id } : null };
    });
  }

  async detail(tenantId: string, eventId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT audit_event_id, identity_user_id, event_type, resource_type, resource_id,
              permission_key, outcome, correlation_id, metadata, created_at
       FROM ${schema}.admin_audit_events WHERE customer_id = $1 AND audit_event_id = $2`,
      [tenantId, eventId],
    ));
    if (!result.rows[0]) throw new NotFoundException("Audit event not found.");
    return safeEvent(result.rows[0]);
  }

  retentionStatus() {
    return {
      policyStatus: "unavailable" as const,
      deletionEnabled: false,
      legalHoldAutomation: "unavailable" as const,
      detail: "No approved retention duration or legal-hold policy is configured; automatic audit deletion remains disabled.",
    };
  }

  async listExports(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT audit_export_job_id, format,
              CASE WHEN expires_at <= now() THEN 'expired' ELSE status END AS status,
              filters, as_of, max_rows, row_count, created_by_identity,
              created_at, expires_at, last_accessed_at, access_count
       FROM ${schema}.admin_audit_export_jobs WHERE customer_id = $1
       ORDER BY created_at DESC LIMIT 100`, [tenantId],
    ));
    return { exports: result.rows };
  }

  async createExport(tenantId: string, actorId: string, input: unknown) {
    const parsed = CreateAuditExportSchema.parse(input); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const asOf = new Date(); const { sql, params } = filterSql(parsed.filters, tenantId, asOf);
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM (
           SELECT 1 FROM ${schema}.admin_audit_events ${sql} LIMIT $${params.length + 1}
         ) bounded`, [...params, parsed.maxRows + 1],
      );
      const rowCount = Number(count.rows[0]?.count ?? 0);
      if (rowCount > parsed.maxRows) throw new ConflictException(`Export exceeds the ${parsed.maxRows} row limit; narrow the filters.`);
      const created = await client.query<{ audit_export_job_id: string; expires_at: string }>(
        `INSERT INTO ${schema}.admin_audit_export_jobs
           (customer_id, format, status, filters, as_of, max_rows, row_count, created_by_identity, expires_at)
         VALUES ($1, $2, 'ready', $3::jsonb, $4, $5, $6, $7, $4::timestamptz + interval '24 hours')
         RETURNING audit_export_job_id, expires_at`,
        [tenantId, parsed.format, JSON.stringify(parsed.filters), asOf.toISOString(), parsed.maxRows, rowCount, actorId],
      );
      const id = created.rows[0].audit_export_job_id;
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.audit_export.created",
        permission: "audit.export", outcome: "allowed", resourceType: "audit_export", resourceId: id,
        metadata: { format: parsed.format, rowCount, maxRows: parsed.maxRows, asOf: asOf.toISOString() } }, client);
      return { auditExportJobId: id, status: "ready" as const, rowCount, asOf: asOf.toISOString(), expiresAt: created.rows[0].expires_at };
    });
  }

  async downloadExport(tenantId: string, exportId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const jobResult = await client.query<{
        filters: unknown; as_of: string; max_rows: number; row_count: number; expires_at: string; status: string;
      }>(`SELECT filters, as_of, max_rows, row_count, expires_at, status
          FROM ${schema}.admin_audit_export_jobs
          WHERE customer_id = $1 AND audit_export_job_id = $2 FOR UPDATE`, [tenantId, exportId]);
      const job = jobResult.rows[0]; if (!job) throw new NotFoundException("Audit export not found.");
      if (job.status === "expired" || Date.parse(job.expires_at) <= Date.now()) {
        await client.query(`UPDATE ${schema}.admin_audit_export_jobs SET status = 'expired' WHERE customer_id = $1 AND audit_export_job_id = $2`, [tenantId, exportId]);
        throw new ConflictException("Audit export has expired.");
      }
      const filters = AuditFiltersSchema.parse(job.filters); const { sql, params } = filterSql(filters, tenantId, new Date(job.as_of));
      const result = await client.query(
        `SELECT audit_event_id, identity_user_id, event_type, resource_type, resource_id,
                permission_key, outcome, correlation_id, metadata, created_at
         FROM ${schema}.admin_audit_events ${sql}
         ORDER BY created_at ASC, audit_event_id ASC LIMIT $${params.length + 1}`,
        [...params, job.max_rows],
      );
      const events = result.rows.map(safeEvent);
      if (events.length !== job.row_count) throw new ConflictException("Pinned audit export evidence is inconsistent; create a new export.");
      const document = { schemaVersion: 1, tenantId, auditExportJobId: exportId, asOf: job.as_of, filters, events };
      const digest = createHash("sha256").update(stableJson(document)).digest("hex");
      await client.query(
        `UPDATE ${schema}.admin_audit_export_jobs
         SET last_accessed_at = now(), access_count = access_count + 1
         WHERE customer_id = $1 AND audit_export_job_id = $2`, [tenantId, exportId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.audit_export.accessed",
        permission: "audit.export", outcome: "allowed", resourceType: "audit_export", resourceId: exportId,
        metadata: { rowCount: events.length, digest } }, client);
      return { format: "json" as const, digestAlgorithm: "sha256" as const, digest, document };
    });
  }
}

function filterSql(filters: Filters, tenantId: string, cutoff?: Date, cursor?: { createdAt: string; eventId: string }) {
  const clauses = ["customer_id = $1"]; const params: unknown[] = [tenantId];
  const add = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace("?", `$${params.length}`)); };
  if (filters.eventType) add("event_type = ?", filters.eventType);
  if (filters.outcome) add("outcome = ?", filters.outcome);
  if (filters.identityUserId) add("identity_user_id = ?", filters.identityUserId);
  if (filters.resourceType) add("resource_type = ?", filters.resourceType);
  if (filters.correlationId) add("correlation_id = ?", filters.correlationId);
  if (filters.from) add("created_at >= ?", filters.from);
  if (filters.to) add("created_at <= ?", filters.to);
  if (cutoff) add("created_at <= ?", cutoff.toISOString());
  if (cursor) {
    params.push(cursor.createdAt, cursor.eventId);
    clauses.push(`(created_at, audit_event_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

function safeEvent(row: Record<string, any>): Record<string, any> & { created_at: string } {
  return { ...row, created_at: row["created_at"] instanceof Date ? row["created_at"].toISOString() : String(row["created_at"]),
    metadata: sanitizeAuditMetadata(row.metadata && typeof row.metadata === "object" ? row.metadata : {}) };
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") { const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
