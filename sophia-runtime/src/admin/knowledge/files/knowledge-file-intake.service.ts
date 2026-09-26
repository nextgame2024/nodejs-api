import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { runtimeConfig } from "../../../config/runtime-config.js";
import { DatabaseService } from "../../../database/database.service.js";
import { AdminAuditService } from "../../authorization/admin-audit.service.js";
import { InitiateKnowledgeFileSchema } from "../knowledge.contracts.js";
import {
  KNOWLEDGE_MALWARE_SCANNER,
  KNOWLEDGE_OBJECT_STORAGE,
  KNOWLEDGE_TEXT_PARSER,
  type KnowledgeMalwareScanner,
  type KnowledgeObjectStorage,
  type KnowledgeTextParser,
} from "./knowledge-file.ports.js";

type IntakeRow = {
  knowledge_file_intake_id: string;
  knowledge_source_id: string;
  knowledge_revision_id: string | null;
  idempotency_key: string;
  status: string;
  object_key: string;
  original_filename: string;
  media_type: "text/plain" | "text/markdown";
  declared_bytes: number;
  declared_sha256_base64: string;
  attempt_count: number;
  created_by_identity: string;
};

@Injectable()
export class KnowledgeFileIntakeService {
  private readonly config = runtimeConfig().knowledgeFiles;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(KNOWLEDGE_OBJECT_STORAGE) private readonly storage: KnowledgeObjectStorage,
    @Inject(KNOWLEDGE_MALWARE_SCANNER) private readonly scanner: KnowledgeMalwareScanner,
    @Inject(KNOWLEDGE_TEXT_PARSER) private readonly parser: KnowledgeTextParser,
  ) {}

  async readiness() {
    const [storage, scanner] = await Promise.all([this.storage.readiness(), this.scanner.readiness()]);
    return {
      enabled: storage.ready && scanner.ready,
      acceptedMediaTypes: ["text/plain", "text/markdown"],
      maxUploadBytes: this.config.maxUploadBytes,
      parserIsolation: "worker_thread" as const,
      storage,
      scanner,
    };
  }

  async list(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT knowledge_file_intake_id, knowledge_source_id, knowledge_revision_id,
              original_filename, media_type, declared_bytes, status, attempt_count,
              scan_engine, scan_signature, parser_version, error_code, error_message,
              created_at, upload_verified_at, processing_started_at, completed_at
       FROM ${schema}.knowledge_file_intakes WHERE customer_id = $1
       ORDER BY created_at DESC LIMIT 100`, [tenantId],
    ));
    return { intakes: result.rows };
  }

  async initiate(tenantId: string, sourceId: string, actorId: string, input: unknown) {
    const value = InitiateKnowledgeFileSchema.parse(input);
    if (value.contentLength > this.config.maxUploadBytes) throw new UnprocessableEntityException("File exceeds the configured knowledge upload limit.");
    const readiness = await this.readiness();
    if (!readiness.enabled) throw new ServiceUnavailableException({ message: "Knowledge file ingestion is not operational.", readiness });
    const schema = runtimeConfig().schema;
    const intake = await this.database.tenantTransaction(tenantId, async (client) => {
      const source = await client.query(
        `SELECT 1 FROM ${schema}.knowledge_sources
         WHERE knowledge_source_id = $1 AND customer_id = $2 AND source_type = 'managed_text' AND status = 'active'`,
        [sourceId, tenantId],
      );
      if (source.rowCount !== 1) throw new NotFoundException("Active managed-text knowledge source not found.");
      const existing = await client.query<IntakeRow>(
        `SELECT * FROM ${schema}.knowledge_file_intakes WHERE customer_id = $1 AND idempotency_key = $2`,
        [tenantId, value.idempotencyKey],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.knowledge_source_id !== sourceId || row.original_filename !== value.filename
          || row.media_type !== value.mediaType || Number(row.declared_bytes) !== value.contentLength
          || row.declared_sha256_base64 !== value.checksumSha256Base64) {
          throw new ConflictException("The idempotency key is already bound to different file metadata.");
        }
        if (row.status !== "awaiting_upload") throw new ConflictException(`File intake is already ${row.status}.`);
        return row;
      }
      const id = randomUUID();
      const objectKey = `private/sophia-knowledge-quarantine/${tenantId}/${id}`;
      const result = await client.query<IntakeRow>(
        `INSERT INTO ${schema}.knowledge_file_intakes (
           knowledge_file_intake_id, customer_id, knowledge_source_id, idempotency_key,
           object_key, original_filename, media_type, declared_bytes,
           declared_sha256_base64, created_by_identity
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, tenantId, sourceId, value.idempotencyKey, objectKey, value.filename,
          value.mediaType, value.contentLength, value.checksumSha256Base64, actorId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.file.initiated", permission: "knowledge.ingest", outcome: "allowed", resourceType: "knowledge_file_intake", resourceId: id, metadata: { mediaType: value.mediaType, contentLength: value.contentLength } }, client);
      return result.rows[0];
    });
    const upload = await this.storage.createUpload({
      objectKey: intake.object_key,
      mediaType: intake.media_type,
      contentLength: Number(intake.declared_bytes),
      checksumSha256Base64: intake.declared_sha256_base64,
    });
    return { knowledgeFileIntakeId: intake.knowledge_file_intake_id, status: intake.status, ...upload };
  }

  async complete(tenantId: string, intakeId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    const intakeResult = await this.database.tenantTransaction(tenantId, (client) => client.query<IntakeRow>(
      `SELECT * FROM ${schema}.knowledge_file_intakes
       WHERE knowledge_file_intake_id = $1 AND customer_id = $2`, [intakeId, tenantId],
    ));
    const intake = intakeResult.rows[0];
    if (!intake) throw new NotFoundException("Knowledge file intake not found.");
    if (["queued", "processing", "succeeded"].includes(intake.status)) return { knowledgeFileIntakeId: intakeId, status: intake.status };
    if (intake.status !== "awaiting_upload") throw new ConflictException(`File intake cannot complete from ${intake.status}.`);
    const object = await this.storage.inspect(intake.object_key).catch(() => undefined);
    const matches = object && object.contentLength === Number(intake.declared_bytes)
      && object.mediaType === intake.media_type
      && object.checksumSha256Base64 === intake.declared_sha256_base64;
    if (!matches) {
      await this.quarantineMetadataMismatch(tenantId, intake, actorId);
      await this.storage.delete(intake.object_key).catch(() => undefined);
      throw new UnprocessableEntityException("Uploaded object metadata or checksum does not match the authorised intake.");
    }
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.knowledge_file_intakes SET status = 'queued', upload_verified_at = now(), error_code = NULL, error_message = NULL
         WHERE knowledge_file_intake_id = $1 AND customer_id = $2 AND status = 'awaiting_upload'`, [intakeId, tenantId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.file.queued", permission: "knowledge.ingest", outcome: "allowed", resourceType: "knowledge_file_intake", resourceId: intakeId }, client);
    });
    return { knowledgeFileIntakeId: intakeId, status: "queued" as const };
  }

  async runOnce(tenantId: string, limit = 5): Promise<{ claimed: number; succeeded: number; quarantined: number; failed: number }> {
    const schema = runtimeConfig().schema;
    const workerId = randomUUID();
    const claimed = await this.database.tenantTransaction(tenantId, async (client) => {
      const result = await client.query<IntakeRow>(
        `SELECT * FROM ${schema}.knowledge_file_intakes
         WHERE customer_id = $1 AND attempt_count < 3
           AND (status IN ('queued','failed') OR (status = 'processing' AND lease_expires_at < now()))
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2`, [tenantId, Math.max(1, Math.min(limit, 20))],
      );
      for (const row of result.rows) {
        await client.query(
          `UPDATE ${schema}.knowledge_file_intakes
           SET status = 'processing', attempt_count = attempt_count + 1, lease_owner = $1,
               lease_expires_at = now() + interval '2 minutes', processing_started_at = COALESCE(processing_started_at, now())
           WHERE knowledge_file_intake_id = $2`, [workerId, row.knowledge_file_intake_id],
        );
      }
      return result.rows;
    });
    const outcome = { claimed: claimed.length, succeeded: 0, quarantined: 0, failed: 0 };
    for (const intake of claimed) {
      try {
        const bytes = await this.storage.readBounded(intake.object_key, Number(intake.declared_bytes));
        if (bytes.byteLength !== Number(intake.declared_bytes)) throw new Error("object_length_changed");
        const checksum = createHash("sha256").update(bytes).digest("base64");
        if (checksum !== intake.declared_sha256_base64) throw new Error("object_checksum_changed");
        const scan = await this.scanner.scan({ bytes, filename: intake.original_filename, mediaType: intake.media_type });
        if (scan.status === "infected") {
          await this.markQuarantined(tenantId, intake, workerId, scan.engine, scan.signature);
          await this.storage.delete(intake.object_key).catch(() => undefined);
          outcome.quarantined += 1;
          continue;
        }
        const parsed = await this.parser.parse({ bytes, mediaType: intake.media_type, maxOutputBytes: 262_144 });
        await this.commitParsedRevision(tenantId, intake, workerId, parsed.text, parsed.parserVersion, scan.engine);
        await this.storage.delete(intake.object_key).catch(() => undefined);
        outcome.succeeded += 1;
      } catch (error) {
        await this.markFailed(tenantId, intake, workerId, error);
        outcome.failed += 1;
      }
    }
    return outcome;
  }

  private async commitParsedRevision(tenantId: string, intake: IntakeRow, workerId: string, text: string, parserVersion: string, scanEngine: string) {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, async (client) => {
      const locked = await this.lockClaim(client, schema, tenantId, intake.knowledge_file_intake_id, workerId);
      if (!locked) throw new ConflictException("Knowledge file lease was lost.");
      const source = await client.query(`SELECT 1 FROM ${schema}.knowledge_sources WHERE knowledge_source_id = $1 AND customer_id = $2 AND status = 'active' FOR UPDATE`, [intake.knowledge_source_id, tenantId]);
      if (source.rowCount !== 1) throw new ConflictException("Knowledge source was retired before file processing completed.");
      const revision = await client.query<{ knowledge_revision_id: string }>(
        `INSERT INTO ${schema}.knowledge_source_revisions (
           knowledge_source_id, customer_id, revision, status, ingestion_status,
           media_type, content_text, content_sha256, created_by_identity
         ) SELECT $1,$2,COALESCE(MAX(revision),0)+1,'draft','ready',$3,$4,$5,$6
           FROM ${schema}.knowledge_source_revisions WHERE knowledge_source_id = $1
         RETURNING knowledge_revision_id`,
        [intake.knowledge_source_id, tenantId, intake.media_type, text, createHash("sha256").update(text, "utf8").digest("hex"), intake.created_by_identity],
      );
      await client.query(
        `UPDATE ${schema}.knowledge_file_intakes SET status = 'succeeded', knowledge_revision_id = $1,
           scan_engine = $2, parser_version = $3, completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
         WHERE knowledge_file_intake_id = $4 AND customer_id = $5`,
        [revision.rows[0].knowledge_revision_id, scanEngine, parserVersion, intake.knowledge_file_intake_id, tenantId],
      );
      await this.audit.record({ tenantId, identityUserId: intake.created_by_identity, eventType: "knowledge.file.ingested", permission: "knowledge.ingest", outcome: "allowed", resourceType: "knowledge_revision", resourceId: revision.rows[0].knowledge_revision_id, metadata: { knowledgeFileIntakeId: intake.knowledge_file_intake_id, parserVersion, scanEngine } }, client);
    });
  }

  private async markQuarantined(tenantId: string, intake: IntakeRow, workerId: string, engine: string, signature?: string) {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.knowledge_file_intakes SET status = 'quarantined', scan_engine = $1,
           scan_signature = $2, error_code = 'malware_detected', error_message = 'File rejected by malware scanner.',
           completed_at = now(), lease_owner = NULL, lease_expires_at = NULL
         WHERE knowledge_file_intake_id = $3 AND customer_id = $4 AND lease_owner = $5`,
        [engine, signature ?? null, intake.knowledge_file_intake_id, tenantId, workerId],
      );
      await this.audit.record({ tenantId, identityUserId: intake.created_by_identity, eventType: "knowledge.file.quarantined", permission: "knowledge.ingest", outcome: "failed", resourceType: "knowledge_file_intake", resourceId: intake.knowledge_file_intake_id, metadata: { scanEngine: engine, signature: signature ?? "detected" } }, client);
    });
  }

  private async markFailed(tenantId: string, intake: IntakeRow, workerId: string, error: unknown) {
    const schema = runtimeConfig().schema;
    const message = safeError(error);
    await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.knowledge_file_intakes SET status = 'failed', error_code = 'processing_failed',
         error_message = $1, lease_owner = NULL, lease_expires_at = NULL,
         completed_at = CASE WHEN attempt_count >= 3 THEN now() ELSE completed_at END
       WHERE knowledge_file_intake_id = $2 AND customer_id = $3 AND lease_owner = $4`,
      [message, intake.knowledge_file_intake_id, tenantId, workerId],
    ));
  }

  private async lockClaim(client: PoolClient, schema: string, tenantId: string, intakeId: string, workerId: string) {
    const result = await client.query(
      `SELECT 1 FROM ${schema}.knowledge_file_intakes
       WHERE knowledge_file_intake_id = $1 AND customer_id = $2 AND status = 'processing' AND lease_owner = $3 FOR UPDATE`,
      [intakeId, tenantId, workerId],
    );
    return result.rowCount === 1;
  }

  private async quarantineMetadataMismatch(tenantId: string, intake: IntakeRow, actorId: string) {
    const schema = runtimeConfig().schema;
    await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE ${schema}.knowledge_file_intakes SET status = 'quarantined', error_code = 'upload_metadata_mismatch',
           error_message = 'Uploaded object metadata or checksum did not match the authorised intake.', completed_at = now()
         WHERE knowledge_file_intake_id = $1 AND customer_id = $2`, [intake.knowledge_file_intake_id, tenantId],
      );
      await this.audit.record({ tenantId, identityUserId: actorId, eventType: "knowledge.file.quarantined", permission: "knowledge.ingest", outcome: "failed", resourceType: "knowledge_file_intake", resourceId: intake.knowledge_file_intake_id, metadata: { reason: "upload_metadata_mismatch" } }, client);
    });
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "processing_failed";
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
}
