import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { PublishedKnowledgeCapabilityService } from "../../capabilities-v2/services/published-knowledge-capability.service.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import {
  CreateKnowledgeRevisionSchema,
  CreateKnowledgeSourceSchema,
  IngestKnowledgeRevisionSchema,
  PreviewKnowledgeSchema,
  PublishKnowledgeRevisionSchema,
} from "./knowledge.contracts.js";

type RevisionRow = {
  knowledge_revision_id: string;
  knowledge_source_id: string;
  source_type: "managed_text" | "connector_reference";
  content_text: string | null;
  ingestion_status: string;
  status: string;
  title: string;
};

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(PublishedKnowledgeCapabilityService) private readonly knowledge: PublishedKnowledgeCapabilityService,
  ) {}

  async list(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT s.knowledge_source_id, s.source_key, s.title, s.source_type, s.status,
              s.created_at, s.retired_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'knowledgeRevisionId', r.knowledge_revision_id, 'revision', r.revision,
                'status', r.status, 'ingestionStatus', r.ingestion_status,
                'mediaType', r.media_type, 'connectorObjectRef', r.connector_object_ref,
                'contentSha256', r.content_sha256, 'failureCode', r.failure_code,
                'failureMessage', r.failure_message, 'createdAt', r.created_at,
                'approvedAt', r.approved_at, 'publishedAt', r.published_at,
                'knowledgeSnapshotId', (SELECT x.knowledge_snapshot_id FROM ${schema}.knowledge_snapshots x
                  WHERE x.knowledge_revision_id = r.knowledge_revision_id),
                'snapshotStatus', (SELECT x.status FROM ${schema}.knowledge_snapshots x
                  WHERE x.knowledge_revision_id = r.knowledge_revision_id),
                'capabilityBindingIds', COALESCE((SELECT jsonb_agg(g.capability_binding_id ORDER BY g.capability_binding_id)
                  FROM ${schema}.knowledge_snapshots x JOIN ${schema}.knowledge_snapshot_grants g
                    ON g.knowledge_snapshot_id = x.knowledge_snapshot_id
                  WHERE x.knowledge_revision_id = r.knowledge_revision_id), '[]'::jsonb)
              ) ORDER BY r.revision DESC) FILTER (WHERE r.knowledge_revision_id IS NOT NULL), '[]'::jsonb) revisions
       FROM ${schema}.knowledge_sources s
       LEFT JOIN ${schema}.knowledge_source_revisions r ON r.knowledge_source_id = s.knowledge_source_id
       WHERE s.customer_id = $1 GROUP BY s.knowledge_source_id ORDER BY s.source_key`,
      [tenantId],
    ));
    return { sources: result.rows };
  }

  async getRevision(tenantId: string, revisionId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT r.knowledge_revision_id, r.revision, r.status, r.ingestion_status,
              r.media_type, r.content_text, r.connector_object_ref, r.content_sha256,
              r.failure_code, r.failure_message, r.created_at, r.approved_at, r.published_at,
              s.knowledge_source_id, s.source_key, s.title, s.source_type, s.status AS source_status
       FROM ${schema}.knowledge_source_revisions r
       JOIN ${schema}.knowledge_sources s ON s.knowledge_source_id = r.knowledge_source_id
       WHERE r.knowledge_revision_id = $1 AND r.customer_id = $2`,
      [revisionId, tenantId],
    ));
    if (!result.rows[0]) throw new NotFoundException("Knowledge revision not found.");
    return { revision: result.rows[0] };
  }

  async listKnowledgeBindings(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT b.capability_binding_id, b.capability_key, b.connector_key, b.enabled,
              v.business_profile_version_id, v.version AS business_profile_version,
              p.business_profile_id, p.profile_key, p.display_name
       FROM ${schema}.capability_bindings b
       JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id = b.business_profile_version_id
       JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
       WHERE p.customer_id = $1 AND b.capability_key = 'knowledge' AND b.enabled = true
       ORDER BY p.display_name, v.version DESC`,
      [tenantId],
    ));
    return { bindings: result.rows };
  }

  async createSource(tenantId: string, actorId: string, input: unknown) {
    const value = CreateKnowledgeSourceSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<{ knowledge_source_id: string }>(
        `INSERT INTO ${schema}.knowledge_sources (customer_id, source_key, title, source_type, created_by_identity)
         VALUES ($1, $2, $3, $4, $5) RETURNING knowledge_source_id`,
        [tenantId, value.sourceKey, value.title, value.sourceType, actorId],
      );
      const sourceId = result.rows[0].knowledge_source_id;
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.source.created", permission: "knowledge.edit", outcome: "allowed", resourceType: "knowledge_source", resourceId: sourceId }, client);
      return { knowledgeSourceId: sourceId, ...value, status: "active" as const };
    });
  }

  async createRevision(tenantId: string, sourceId: string, actorId: string, input: unknown) {
    const value = CreateKnowledgeRevisionSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const source = await client.query<{ source_type: string }>(
        `SELECT source_type FROM ${schema}.knowledge_sources WHERE knowledge_source_id = $1 AND customer_id = $2 AND status = 'active' FOR UPDATE`,
        [sourceId, tenantId],
      );
      if (!source.rows[0]) throw new NotFoundException("Active knowledge source not found.");
      if (source.rows[0].source_type !== value.sourceType) throw new UnprocessableEntityException("Revision type must match its source.");
      const managed = value.sourceType === "managed_text";
      if (!managed) {
        const connector = await client.query(
          `SELECT 1 FROM ${schema}.connector_bindings
           WHERE connector_binding_id = $1 AND customer_id = $2 AND status = 'active'`,
          [value.connectorBindingId, tenantId],
        );
        if (connector.rowCount !== 1) throw new UnprocessableEntityException("Connector reference requires an active tenant connector binding.");
      }
      const result = await client.query<{ knowledge_revision_id: string; revision: number }>(
        `INSERT INTO ${schema}.knowledge_source_revisions (
           knowledge_source_id, customer_id, revision, media_type, content_text,
           connector_binding_id, connector_object_ref, content_sha256, created_by_identity
         ) SELECT $1, $2, COALESCE(MAX(revision), 0) + 1, $3, $4, $5, $6, $7, $8
           FROM ${schema}.knowledge_source_revisions WHERE knowledge_source_id = $1
         RETURNING knowledge_revision_id, revision`,
        [sourceId, tenantId, managed ? value.mediaType : null, managed ? value.contentText : null,
          managed ? null : value.connectorBindingId, managed ? null : value.connectorObjectRef,
          managed ? sha256(value.contentText) : sha256(`${value.connectorBindingId}:${value.connectorObjectRef}`), actorId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.revision.created", permission: "knowledge.edit", outcome: "allowed", resourceType: "knowledge_revision", resourceId: result.rows[0].knowledge_revision_id }, client);
      return { ...result.rows[0], status: "draft" as const, ingestionStatus: "pending" as const };
    });
  }

  async ingest(tenantId: string, revisionId: string, actorId: string, input: unknown) {
    const value = IngestKnowledgeRevisionSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const existing = await client.query(
        `SELECT knowledge_ingestion_job_id, knowledge_revision_id, status, attempt_count, error_code, error_message
         FROM ${schema}.knowledge_ingestion_jobs WHERE customer_id = $1 AND idempotency_key = $2`,
        [tenantId, value.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].knowledge_revision_id !== revisionId) {
          throw new ConflictException("The idempotency key is already bound to another knowledge revision.");
        }
        return {
          knowledgeIngestionJobId: existing.rows[0].knowledge_ingestion_job_id,
          status: existing.rows[0].status,
          attemptCount: existing.rows[0].attempt_count,
          errorCode: existing.rows[0].error_code ?? undefined,
          errorMessage: existing.rows[0].error_message ?? undefined,
        };
      }
      const revision = await this.loadRevision(client, schema, tenantId, revisionId, true);
      if (!revision) throw new NotFoundException("Knowledge revision not found.");
      if (revision.status !== "draft") throw new ConflictException("Only draft revisions can be ingested.");
      if (revision.source_type === "connector_reference") {
        throw new UnprocessableEntityException("Connector references remain pending until their approved connector ingestion adapter is available.");
      }
      const job = await client.query<{ knowledge_ingestion_job_id: string }>(
        `INSERT INTO ${schema}.knowledge_ingestion_jobs (
           customer_id, knowledge_revision_id, idempotency_key, status, completed_at
         ) VALUES ($1, $2, $3, 'succeeded', now()) RETURNING knowledge_ingestion_job_id`,
        [tenantId, revisionId, value.idempotencyKey],
      );
      await client.query(
        `UPDATE ${schema}.knowledge_source_revisions SET ingestion_status = 'ready', failure_code = NULL, failure_message = NULL
         WHERE knowledge_revision_id = $1 AND customer_id = $2`,
        [revisionId, tenantId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.revision.ingested", permission: "knowledge.ingest", outcome: "allowed", resourceType: "knowledge_revision", resourceId: revisionId, metadata: { ingestionJobId: job.rows[0].knowledge_ingestion_job_id } }, client);
      return { knowledgeIngestionJobId: job.rows[0].knowledge_ingestion_job_id, status: "succeeded" as const, attemptCount: 1 };
    });
  }

  async approve(tenantId: string, revisionId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE ${schema}.knowledge_source_revisions SET status = 'approved', approved_at = now()
         WHERE knowledge_revision_id = $1 AND customer_id = $2 AND status = 'draft' AND ingestion_status = 'ready'
         RETURNING knowledge_revision_id`, [revisionId, tenantId],
      );
      if (result.rowCount !== 1) throw new ConflictException("Revision must be an ingested tenant draft before approval.");
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.revision.approved", permission: "knowledge.publish", outcome: "allowed", resourceType: "knowledge_revision", resourceId: revisionId }, client);
      return { knowledgeRevisionId: revisionId, status: "approved" as const };
    });
  }

  async publish(tenantId: string, revisionId: string, actorId: string, input: unknown) {
    const value = PublishKnowledgeRevisionSchema.parse(input);
    const grants = [...new Set(value.capabilityBindingIds)];
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const revision = await this.loadRevision(client, schema, tenantId, revisionId, true);
      if (!revision || revision.status !== "approved" || revision.ingestion_status !== "ready" || !revision.content_text) {
        throw new ConflictException("Only approved, ready managed text can be published.");
      }
      const allowed = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM ${schema}.capability_bindings b
         JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id = b.business_profile_version_id
         JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
         WHERE b.capability_binding_id = ANY($1::uuid[]) AND b.capability_key = 'knowledge'
           AND b.enabled = true AND p.customer_id = $2`, [grants, tenantId],
      );
      if (Number(allowed.rows[0]?.count ?? 0) !== grants.length) {
        throw new UnprocessableEntityException("Every grant must be an enabled tenant knowledge capability binding.");
      }
      const snapshot = await client.query<{ knowledge_snapshot_id: string }>(
        `INSERT INTO ${schema}.knowledge_snapshots (customer_id, knowledge_revision_id, published_by_identity)
         VALUES ($1, $2, $3) RETURNING knowledge_snapshot_id`, [tenantId, revisionId, actorId],
      );
      const snapshotId = snapshot.rows[0].knowledge_snapshot_id;
      await client.query(
        `INSERT INTO ${schema}.knowledge_snapshot_grants (knowledge_snapshot_id, customer_id, capability_binding_id)
         SELECT $1, $2, unnest($3::uuid[])`, [snapshotId, tenantId, grants],
      );
      await client.query(
        `INSERT INTO ${schema}.knowledge_index_documents (knowledge_snapshot_id, customer_id, title, document_text)
         VALUES ($1, $2, $3, $4)`, [snapshotId, tenantId, revision.title, revision.content_text],
      );
      await client.query(
        `UPDATE ${schema}.knowledge_source_revisions SET status = 'published', published_at = now()
         WHERE knowledge_revision_id = $1 AND customer_id = $2`, [revisionId, tenantId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.revision.published", permission: "knowledge.publish", outcome: "allowed", resourceType: "knowledge_snapshot", resourceId: snapshotId, metadata: { knowledgeRevisionId: revisionId, grantCount: grants.length } }, client);
      return { knowledgeSnapshotId: snapshotId, knowledgeRevisionId: revisionId, status: "published" as const };
    });
  }

  async retire(tenantId: string, sourceId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE ${schema}.knowledge_sources SET status = 'retired', retired_at = now()
         WHERE knowledge_source_id = $1 AND customer_id = $2 AND status = 'active' RETURNING knowledge_source_id`,
        [sourceId, tenantId],
      );
      if (result.rowCount !== 1) throw new NotFoundException("Active knowledge source not found.");
      await client.query(
        `UPDATE ${schema}.knowledge_snapshots s SET status = 'retired', retired_at = now()
         FROM ${schema}.knowledge_source_revisions r
         WHERE s.knowledge_revision_id = r.knowledge_revision_id AND r.knowledge_source_id = $1 AND s.customer_id = $2 AND s.status = 'published'`,
        [sourceId, tenantId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.source.retired", permission: "knowledge.retire", outcome: "allowed", resourceType: "knowledge_source", resourceId: sourceId }, client);
      return { knowledgeSourceId: sourceId, status: "retired" as const };
    });
  }

  preview(tenantId: string, input: unknown) {
    const value = PreviewKnowledgeSchema.parse(input);
    return this.knowledge.searchPublishedSnapshot({ tenantId, ...value });
  }

  private async loadRevision(client: PoolClient, schema: string, tenantId: string, revisionId: string, lock: boolean): Promise<RevisionRow | undefined> {
    const result = await client.query<RevisionRow>(
      `SELECT r.knowledge_revision_id, r.knowledge_source_id, r.content_text, r.ingestion_status, r.status,
              s.source_type, s.title
       FROM ${schema}.knowledge_source_revisions r JOIN ${schema}.knowledge_sources s ON s.knowledge_source_id = r.knowledge_source_id
       WHERE r.knowledge_revision_id = $1 AND r.customer_id = $2${lock ? " FOR UPDATE OF r" : ""}`,
      [revisionId, tenantId],
    );
    return result.rows[0];
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
