import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import { ConversationListQuerySchema, CreateConversationExportSchema, CreateConversationNoteSchema } from "./conversation-admin.contracts.js";

type Row = Record<string, any>;
type TimelineItem = { id: string; kind: string; occurredAt: string; [key: string]: unknown };

@Injectable()
export class ConversationAdminService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async list(tenantId: string, query: unknown) {
    const value = ConversationListQuerySchema.parse(query);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const clauses = ["s.customer_id = $1"];
      const params: unknown[] = [tenantId];
      const add = (sql: string, parameter: unknown) => {
        params.push(parameter); clauses.push(sql.replace("?", `$${params.length}`));
      };
      if (value.from) add("s.started_at >= ?", value.from);
      if (value.to) add("s.started_at <= ?", value.to);
      if (value.agentId) add("r.agent_id = ?", value.agentId);
      if (value.agentReleaseId) add("s.agent_release_id = ?", value.agentReleaseId);
      if (value.channel) add(`${channelSql("s")} = ?`, value.channel);
      if (value.outcome) add(`${outcomeSql("s")} = ?`, value.outcome);
      if (value.escalationStatus === "none") clauses.push("ec.escalation_case_id IS NULL");
      else if (value.escalationStatus) add("ec.status = ?", value.escalationStatus);
      if (value.before && value.beforeId) {
        params.push(value.before, value.beforeId);
        clauses.push(`(s.started_at, s.session_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const result = await client.query(
        `SELECT s.session_id, s.status, s.runtime_api_version, s.agent_release_id, s.started_at, s.ended_at,
                r.agent_id, r.release_number, a.agent_key, ${channelSql("s")} AS channel,
                ${outcomeSql("s")} AS outcome, ec.escalation_case_id, ec.status AS escalation_status,
                (SELECT count(*)::int FROM ${schema}.tool_calls t
                 WHERE t.customer_id = s.customer_id AND t.session_id = s.session_id) AS tool_call_count
         FROM ${schema}.sessions s
         LEFT JOIN ${schema}.agent_release_manifests r ON r.agent_release_id = s.agent_release_id
         LEFT JOIN ${schema}.agents a ON a.agent_id = r.agent_id
         LEFT JOIN LATERAL (
           SELECT c.escalation_case_id, c.status FROM ${schema}.escalation_cases c
           WHERE c.customer_id = s.customer_id AND c.source_session_id = s.session_id
           ORDER BY c.created_at DESC, c.escalation_case_id DESC LIMIT 1
         ) ec ON true
         WHERE ${clauses.join(" AND ")}
         ORDER BY s.started_at DESC, s.session_id DESC LIMIT $${params.length + 1}`,
        [...params, value.limit + 1],
      );
      const hasMore = result.rows.length > value.limit;
      const conversations = result.rows.slice(0, value.limit).map(normalizeDates);
      const last = hasMore ? conversations.at(-1) : undefined;
      return { conversations, hasMore, nextCursor: last
        ? { before: last.started_at, beforeId: last.session_id } : null };
    });
  }

  async detail(tenantId: string, sessionId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const session = await this.session(client, schema, tenantId, sessionId);
      const tools = await client.query(`SELECT tool_call_id AS id, tool_name, status, policy_decision, outcome_class,
          started_at AS occurred_at, completed_at FROM ${schema}.tool_calls
          WHERE customer_id = $1 AND session_id = $2`, [tenantId, sessionId]);
      const reviews = await client.query(`SELECT review_id AS id, action_type, status, created_at AS occurred_at,
          confirmed_at, committed_at, invalidated_at FROM ${schema}.action_reviews
          WHERE customer_id = $1 AND session_id = $2`, [tenantId, sessionId]);
      const events = await client.query(`SELECT event_id AS id, event_type, created_at AS occurred_at FROM ${schema}.events
          WHERE customer_id = $1 AND session_id = $2`, [tenantId, sessionId]);
      const workflows = await client.query(`SELECT workflow_run_id AS id, workflow_version_id, owner_key, last_status AS status,
          COALESCE(last_status_at, created_at) AS occurred_at FROM ${schema}.workflow_run_references
          WHERE customer_id = $1 AND source_session_id = $2`, [tenantId, sessionId]);
      const cases = await client.query(`SELECT escalation_case_id, reason_code, priority, status, delivery_status, transfer_status,
          assigned_to_identity, created_at FROM ${schema}.escalation_cases
          WHERE customer_id = $1 AND source_session_id = $2 ORDER BY created_at, escalation_case_id`, [tenantId, sessionId]);
      const caseIds = cases.rows.map((row) => row.escalation_case_id);
      const caseEvents = caseIds.length ? await client.query(
        `SELECT escalation_case_event_id AS id, escalation_case_id, event_type, status, delivery_status,
          transfer_status, actor_identity, created_at AS occurred_at FROM ${schema}.escalation_case_events
         WHERE customer_id = $1 AND escalation_case_id = ANY($2::uuid[])`, [tenantId, caseIds],
      ) : { rows: [] as Row[] };
      const timeline: TimelineItem[] = [
        { id: `session:${sessionId}:started`, kind: "session.started", occurredAt: iso(session.started_at), status: session.status },
        ...tools.rows.map((row) => timelineItem("tool", row)),
        ...reviews.rows.map((row) => timelineItem("review", row)),
        ...events.rows.map((row) => timelineItem("event", row)),
        ...workflows.rows.map((row) => timelineItem("workflow", row)),
        ...caseEvents.rows.map((row) => timelineItem("escalation", row)),
        ...(session.ended_at ? [{ id: `session:${sessionId}:ended`, kind: "session.ended",
          occurredAt: iso(session.ended_at), status: session.status }] : []),
      ].sort(timelineOrder);
      return {
        session: metadataSession(session), timeline,
        escalations: cases.rows.map(normalizeDates),
        contentAccess: { requiredPermission: "conversations.read_content", recentMfaRequired: true },
        transcript: { status: "unavailable_not_recorded" },
        audio: { status: "unavailable_not_recorded" },
      };
    });
  }

  async content(tenantId: string, sessionId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const session = await this.session(client, schema, tenantId, sessionId);
      const policy = await client.query(`SELECT pc.full_transcript_persistence_enabled, pc.raw_audio_recording_enabled,
          EXISTS (
            SELECT 1 FROM ${schema}.privacy_subject_bindings b
            JOIN ${schema}.privacy_legal_holds h ON h.customer_id = b.customer_id
              AND h.subject_reference_digest = b.subject_reference_digest AND h.status = 'active'
            WHERE b.customer_id = $1 AND b.session_id = $2
          ) AS active_hold,
          (SELECT retention_days FROM ${schema}.privacy_retention_policies p
            WHERE p.customer_id = $1 AND p.dataset_key = 'session_content' AND p.status = 'approved'
            ORDER BY p.version DESC LIMIT 1) AS content_retention_days,
          (SELECT retention_days FROM ${schema}.privacy_retention_policies p
            WHERE p.customer_id = $1 AND p.dataset_key = 'review_payloads' AND p.status = 'approved'
            ORDER BY p.version DESC LIMIT 1) AS review_retention_days
        FROM ${schema}.session_privacy_controls pc WHERE pc.customer_id = $1 AND pc.session_id = $2`,
        [tenantId, sessionId]);
      const controls = policy.rows[0] ?? {};
      const contentExpired = expired(session.started_at, controls.content_retention_days, controls.active_hold);
      const reviewsExpired = expired(session.started_at, controls.review_retention_days, controls.active_hold);
      const tools = contentExpired ? await empty() : await client.query(`SELECT tool_call_id AS id, tool_name, status, input, output,
          error_message, error_code, started_at AS occurred_at FROM ${schema}.tool_calls
          WHERE customer_id = $1 AND session_id = $2`, [tenantId, sessionId]);
      const reviews = reviewsExpired ? await empty() : await client.query(`SELECT review_id AS id, action_type, status, payload,
          created_at AS occurred_at FROM ${schema}.action_reviews
          WHERE customer_id = $1 AND session_id = $2`, [tenantId, sessionId]);
      const events = contentExpired ? await empty() : await client.query(`SELECT event_id AS id, event_type, payload,
          created_at AS occurred_at FROM ${schema}.events
          WHERE customer_id = $1 AND session_id = $2`, [tenantId, sessionId]);
      const notes = contentExpired ? await empty() : await client.query(`SELECT conversation_operator_note_id AS id, note_text,
          created_by_identity, created_at AS occurred_at FROM ${schema}.conversation_operator_notes
          WHERE customer_id = $1 AND session_id = $2`, [tenantId, sessionId]);
      const items = [
        ...tools.rows.map((row) => contentItem("tool", row)),
        ...reviews.rows.map((row) => contentItem("review", row)),
        ...events.rows.map((row) => contentItem("event", row)),
        ...notes.rows.map((row) => contentItem("note", row)),
      ].sort(timelineOrder);
      const contentStatus = contentExpired && reviewsExpired ? "unavailable_expired"
        : contentExpired || reviewsExpired ? "partially_available" : "available";
      return {
        sessionId,
        operationalContent: { status: contentStatus, items },
        reviewContentStatus: reviewsExpired ? "unavailable_expired" : "available",
        transcript: { status: controls.full_transcript_persistence_enabled
          ? (contentExpired ? "unavailable_expired" : "unavailable_no_retained_asset") : "unavailable_not_recorded" },
        audio: { status: controls.raw_audio_recording_enabled
          ? (contentExpired ? "unavailable_expired" : "unavailable_no_retained_asset") : "unavailable_not_recorded" },
      };
    });
  }

  async addNote(tenantId: string, sessionId: string, actorId: string, input: unknown) {
    const value = CreateConversationNoteSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${schema}.conversation_operator_notes (customer_id, session_id, note_text, created_by_identity)
         SELECT $1, s.session_id, $3, $4 FROM ${schema}.sessions s
         WHERE s.customer_id = $1 AND s.session_id = $2
         RETURNING conversation_operator_note_id, session_id, created_by_identity, created_at`,
        [tenantId, sessionId, value.note, actorId],
      );
      if (!inserted.rows[0]) throw new NotFoundException("Conversation not found.");
      const note = inserted.rows[0];
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.conversation_note.created",
        permission: "conversations.annotate", outcome: "allowed", resourceType: "conversation",
        resourceId: sessionId, metadata: { noteId: note.conversation_operator_note_id } }, client);
      return { conversationOperatorNoteId: note.conversation_operator_note_id, sessionId,
        createdByIdentity: actorId, createdAt: iso(note.created_at) };
    });
  }

  async listExports(tenantId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.conversation_export_jobs SET status = 'expired'
         WHERE customer_id = $1 AND status = 'ready' AND expires_at <= now()`, [tenantId]);
      const result = await client.query(
        `SELECT conversation_export_job_id, session_id, format, export_scope, status, as_of,
                max_items, initial_item_count, created_by_identity, created_at, expires_at,
                last_accessed_at, access_count
         FROM ${schema}.conversation_export_jobs WHERE customer_id = $1
         ORDER BY created_at DESC LIMIT 100`, [tenantId]);
      return { exports: result.rows.map(normalizeDates) };
    });
  }

  async createExport(tenantId: string, sessionId: string, actorId: string, input: unknown, canReadContent: boolean) {
    const value = CreateConversationExportSchema.parse(input);
    this.assertExportScope(value.scope, canReadContent);
    const asOf = new Date();
    const detail = trimAsOf(await this.detail(tenantId, sessionId), asOf);
    const content = value.scope === "content" ? trimAsOf(await this.content(tenantId, sessionId), asOf) : undefined;
    const itemCount = exportItemCount(detail, content);
    if (itemCount > value.maxItems) {
      throw new ConflictException(`Export exceeds the ${value.maxItems} item limit; choose a larger approved bound.`);
    }
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO ${schema}.conversation_export_jobs
          (customer_id, session_id, format, export_scope, status, as_of, max_items,
           initial_item_count, created_by_identity, expires_at)
         VALUES ($1, $2, 'json', $3, 'ready', $4, $5, $6, $7, $4::timestamptz + interval '24 hours')
         RETURNING conversation_export_job_id, status, export_scope, initial_item_count, as_of, expires_at`,
        [tenantId, sessionId, value.scope, asOf.toISOString(), value.maxItems, itemCount, actorId]);
      const job = result.rows[0];
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.conversation_export.created",
        permission: "conversations.export", outcome: "allowed", resourceType: "conversation_export",
        resourceId: job.conversation_export_job_id,
        metadata: { sessionId, scope: value.scope, itemCount, maxItems: value.maxItems, asOf: asOf.toISOString() } }, client);
      return normalizeDates(job);
    });
  }

  async downloadExport(tenantId: string, exportId: string, actorId: string, canReadContent: boolean) {
    const schema = runtimeConfig().schema;
    const job = await this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `SELECT conversation_export_job_id, session_id, export_scope, status, as_of,
                max_items, initial_item_count, expires_at
         FROM ${schema}.conversation_export_jobs
         WHERE customer_id = $1 AND conversation_export_job_id = $2 FOR UPDATE`, [tenantId, exportId]);
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Conversation export not found.");
      this.assertExportScope(row.export_scope, canReadContent);
      return row;
    });
    if (job.status === "expired" || Date.parse(iso(job.expires_at)) <= Date.now()) {
      await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${schema}.conversation_export_jobs SET status = 'expired'
         WHERE customer_id = $1 AND conversation_export_job_id = $2`, [tenantId, exportId]));
      throw new ConflictException("Conversation export has expired.");
    }
    const asOf = new Date(job.as_of);
    const detail = trimAsOf(await this.detail(tenantId, job.session_id), asOf);
    const content = job.export_scope === "content"
      ? trimAsOf(await this.content(tenantId, job.session_id), asOf) : undefined;
    const itemCount = exportItemCount(detail, content);
    if (itemCount > job.max_items) throw new ConflictException("Pinned conversation export exceeds its approved item bound.");
    const document = {
      schemaVersion: 1, tenantId, conversationExportJobId: exportId, sessionId: job.session_id,
      scope: job.export_scope, asOf: iso(job.as_of), privacyEvaluatedAtAccess: true,
      detail, ...(content ? { content } : {}),
    };
    const digest = createHash("sha256").update(stableJson(document)).digest("hex");
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.conversation_export_jobs
         SET last_accessed_at = now(), access_count = access_count + 1
         WHERE customer_id = $1 AND conversation_export_job_id = $2`, [tenantId, exportId]);
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "admin.conversation_export.accessed",
        permission: "conversations.export", outcome: "allowed", resourceType: "conversation_export",
        resourceId: exportId, metadata: { sessionId: job.session_id, scope: job.export_scope, itemCount, digest } }, client);
    });
    return { format: "json" as const, digestAlgorithm: "sha256" as const, digest, document };
  }

  private async session(client: PoolClient, schema: string, tenantId: string, sessionId: string): Promise<Row> {
    const result = await client.query(
      `SELECT s.session_id, s.status, s.runtime_api_version, s.agent_release_id, s.started_at, s.ended_at,
              r.agent_id, r.release_number, a.agent_key, ${channelSql("s")} AS channel, ${outcomeSql("s")} AS outcome
       FROM ${schema}.sessions s
       LEFT JOIN ${schema}.agent_release_manifests r ON r.agent_release_id = s.agent_release_id
       LEFT JOIN ${schema}.agents a ON a.agent_id = r.agent_id
       WHERE s.customer_id = $1 AND s.session_id = $2`, [tenantId, sessionId],
    );
    if (!result.rows[0]) throw new NotFoundException("Conversation not found.");
    return result.rows[0];
  }

  private assertExportScope(scope: string, canReadContent: boolean): void {
    if (scope === "content" && !canReadContent) {
      throw new ForbiddenException("Conversation content permission is required for a content export.");
    }
  }
}

function channelSql(alias: string): string {
  return `CASE WHEN ${alias}.session_plan_snapshot->>'pipelineMode' = 'avatar-realtime' OR ${alias}.avatar_provider <> 'none'
    THEN 'avatar' WHEN ${alias}.session_plan_snapshot->>'pipelineMode' IN ('native-realtime', 'chained-voice')
    THEN 'voice' ELSE 'unknown' END`;
}
function outcomeSql(alias: string): string {
  return `CASE WHEN ${alias}.status IN ('created', 'active', 'closing', 'cleanup_pending') THEN 'in_progress'
    WHEN ${alias}.status = 'closed' THEN 'completed' ELSE 'failed' END`;
}
function metadataSession(row: Row) { return normalizeDates({ session_id: row.session_id, status: row.status,
  runtime_api_version: row.runtime_api_version, agent_release_id: row.agent_release_id, agent_id: row.agent_id,
  release_number: row.release_number, agent_key: row.agent_key, channel: row.channel, outcome: row.outcome,
  started_at: row.started_at, ended_at: row.ended_at }); }
function timelineItem(prefix: string, row: Row): TimelineItem {
  const { id, occurred_at, ...metadata } = row;
  return { id: `${prefix}:${id}`, kind: `${prefix}.${row.event_type ?? row.status ?? "recorded"}`,
    occurredAt: iso(occurred_at), ...normalizeDates(metadata) };
}
function contentItem(prefix: string, row: Row): TimelineItem {
  const { id, occurred_at, ...content } = row;
  return { id: `${prefix}:${id}`, kind: `${prefix}.content`, occurredAt: iso(occurred_at),
    content: sanitizeContent(content) };
}
function timelineOrder(left: TimelineItem, right: TimelineItem) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}
function normalizeDates(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value instanceof Date ? value.toISOString() : value]));
}
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : String(value); }
function expired(startedAt: Date | string, retentionDays: unknown, activeHold: unknown): boolean {
  if (activeHold || !Number.isInteger(Number(retentionDays)) || Number(retentionDays) <= 0) return false;
  return Date.parse(iso(startedAt)) + Number(retentionDays) * 86_400_000 <= Date.now();
}
function empty(): Promise<{ rows: Row[] }> { return Promise.resolve({ rows: [] }); }
function sanitizeContent(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeContent(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 20_000
    ? `${value.slice(0, 20_000)}…` : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([key, child]) => [key,
    /token|secret|authorization|credential|meeting|api[-_]?key/i.test(key) ? "[REDACTED]" : sanitizeContent(child, depth + 1)]));
}
function trimAsOf<T extends Row>(value: T, asOf: Date): T {
  const cutoff = asOf.toISOString();
  const clone = structuredClone(value) as Row;
  if (Array.isArray(clone.timeline)) clone.timeline = clone.timeline.filter((item: Row) => item.occurredAt <= cutoff);
  if (clone.operationalContent && typeof clone.operationalContent === "object") {
    const operational = clone.operationalContent as Row;
    if (Array.isArray(operational.items)) operational.items = operational.items.filter((item: Row) => item.occurredAt <= cutoff);
  }
  return clone as T;
}
function exportItemCount(detail: Row, content?: Row): number {
  const metadataItems = Array.isArray(detail.timeline) ? detail.timeline.length : 0;
  const contentItems = Array.isArray(content?.operationalContent?.items) ? content.operationalContent.items.length : 0;
  return metadataItems + contentItems;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
