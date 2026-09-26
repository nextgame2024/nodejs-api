import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { BusinessManagerClient } from "../../business-packs/real-estate/business-manager.client.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { ExternalTargetEvidenceSchema, RetentionRunSchema } from "./privacy.contracts.js";

type RequestRow = {
  privacy_subject_request_id: string;
  request_type: "access" | "deletion";
  subject_reference_digest: string;
  selectors: { sessionIds?: unknown };
  verification_status: string;
  status: string;
  processing_started_at: Date | string | null;
};

type TargetOutcome = {
  status: "completed" | "blocked" | "not_applicable";
  verificationMethod: "runtime_transaction" | "owner_api" | "approved_not_stored" | "documented_manual_evidence" | "system_evaluation";
  evidenceReference: string;
  evidenceDigest: string;
  detail: string;
  counts?: Record<string, number>;
};

const sessionIdsSchema = z.array(z.string().uuid()).min(1).max(50);

@Injectable()
export class PrivacyExecutionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() private readonly businessManager?: BusinessManagerClient,
  ) {}

  async execute(tenantId: string, requestId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    const prepared = await this.database.tenantTransaction(tenantId, async (client) => {
      const request = await this.lockExecutableRequest(client, schema, tenantId, requestId);
      const sessionIds = sessionIdsSchema.parse(request.selectors.sessionIds);
      await this.assertNoHold(client, schema, tenantId, request.subject_reference_digest);
      const sessions = await client.query<{
        session_id: string; status: string; ai_provider: string; avatar_provider: string;
      }>(`SELECT session_id, status, ai_provider, avatar_provider FROM ${schema}.sessions
          WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) FOR UPDATE`, [tenantId, sessionIds]);
      if (sessions.rows.length !== sessionIds.length) throw new NotFoundException("A selected session is unavailable or outside this tenant.");
      const nonTerminal = sessions.rows.filter((row) => !["closed", "failed"].includes(row.status));
      if (nonTerminal.length) throw new ConflictException("All selected sessions must be closed before privacy execution.");
      const allocations = await client.query<{ stage: string; provider_snapshot: Record<string, unknown> }>(
        `SELECT stage, provider_snapshot FROM ${schema}.provider_session_allocations
         WHERE customer_id = $1 AND session_id = ANY($2::uuid[])`, [tenantId, sessionIds]);
      if (allocations.rows.some((row) => row.stage !== "released" && !(row.stage === "failed" && Object.keys(row.provider_snapshot ?? {}).length === 0))) {
        throw new ConflictException("Provider cleanup must be verified before privacy execution.");
      }
      const commands = await client.query<{ command_id: string }>(
        `SELECT DISTINCT command_id::text AS command_id FROM ${schema}.action_reviews
         WHERE customer_id = $1 AND session_id = ANY($2::uuid[])`, [tenantId, sessionIds]);
      await client.query(
        `UPDATE ${schema}.privacy_subject_requests SET status = 'processing', processing_started_at = now()
         WHERE customer_id = $1 AND privacy_subject_request_id = $2`, [tenantId, requestId]);
      await this.event(client, schema, tenantId, requestId, "execution_started", actorId,
        { requestType: request.request_type, sessionCount: sessionIds.length });
      return {
        request,
        sessionIds,
        commandIds: commands.rows.map((row) => row.command_id),
        providers: [...new Set(sessions.rows.flatMap((row) => [row.ai_provider, row.avatar_provider]).filter((value) => value && value !== "none"))],
      };
    });

    const businessManager = await this.processBusinessManager(prepared.request.request_type, prepared.commandIds);

    return this.database.tenantTransaction(tenantId, async (client) => {
      const request = await this.requestForUpdate(client, schema, tenantId, requestId);
      await this.assertNoHold(client, schema, tenantId, request.subject_reference_digest);
      let accessDocument: Record<string, unknown> | undefined;
      if (request.request_type === "deletion") {
        const outcomes = await this.redactRuntime(client, schema, tenantId, prepared.sessionIds);
        await this.setTarget(client, schema, tenantId, requestId, "runtime_session_content", outcomes.sessionContent, actorId);
        await this.setTarget(client, schema, tenantId, requestId, "runtime_review_payloads", outcomes.reviewPayloads, actorId);
        await this.setTarget(client, schema, tenantId, requestId, "runtime_operational_metadata", outcomes.operationalMetadata, actorId);
      } else {
        const runtime = await this.accessRuntime(client, schema, tenantId, prepared.sessionIds);
        accessDocument = { schemaVersion: 1, tenantId, requestId, runtime, businessManager: businessManager.document ?? null };
        const accessDigest = digest(accessDocument);
        for (const targetKey of ["runtime_session_content", "runtime_review_payloads", "runtime_operational_metadata"] as const) {
          await this.setTarget(client, schema, tenantId, requestId, targetKey, {
            status: "completed", verificationMethod: "runtime_transaction",
            evidenceReference: `privacy-request:${requestId}:access`, evidenceDigest: accessDigest,
            detail: "Authorised access snapshot generated in the request response; no duplicate personal-data artifact was persisted.",
          }, actorId);
        }
      }
      await this.setTarget(client, schema, tenantId, requestId, "business_manager_documents", businessManager.outcome, actorId);
      const provider = await this.providerOutcome(client, schema, tenantId, prepared.providers, requestId);
      await this.setTarget(client, schema, tenantId, requestId, "provider_owned_data", provider, actorId);
      await this.setTarget(client, schema, tenantId, requestId, "backups", blocked(
        `privacy-request:${requestId}:backups`, "Backup expiry/deletion has no verified deployment adapter or evidence yet."), actorId);
      const final = await this.finalize(client, schema, tenantId, requestId, actorId);
      return {
        privacySubjectRequestId: requestId,
        requestType: request.request_type,
        ...final,
        ...(accessDocument ? { accessDocument, accessDigest: digest(accessDocument) } : {}),
      };
    });
  }

  async recordExternalEvidence(tenantId: string, requestId: string, targetKey: string, actorId: string, input: unknown) {
    const value = ExternalTargetEvidenceSchema.parse(input);
    if (!["business_manager_documents", "provider_owned_data", "backups"].includes(targetKey)) {
      throw new ConflictException("Only an external-owner target accepts owner evidence.");
    }
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const request = await this.requestForUpdate(client, schema, tenantId, requestId);
      if (request.verification_status !== "verified") throw new ConflictException("The subject request is not verified.");
      await this.assertNoHold(client, schema, tenantId, request.subject_reference_digest);
      const outcome: TargetOutcome = {
        status: value.status,
        verificationMethod: "documented_manual_evidence",
        evidenceReference: value.evidenceReference ?? `privacy-request:${requestId}:${targetKey}:blocked`,
        evidenceDigest: value.evidenceDigest ?? digest({ targetKey, detail: value.detail }),
        detail: value.detail ?? "External owner evidence recorded by an authorised administrator.",
      };
      await this.setTarget(client, schema, tenantId, requestId, targetKey, outcome, actorId);
      return { privacySubjectRequestId: requestId, ...(await this.finalize(client, schema, tenantId, requestId, actorId)) };
    });
  }

  async retentionRun(tenantId: string, actorId: string, input: unknown) {
    const value = RetentionRunSchema.parse(input); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const policyResult = await client.query<{
        privacy_retention_policy_id: string; dataset_key: "session_content" | "review_payloads"; retention_days: number;
      }>(`SELECT privacy_retention_policy_id, dataset_key, retention_days
          FROM ${schema}.privacy_retention_policies
          WHERE customer_id = $1 AND privacy_retention_policy_id = $2 AND status = 'approved'
            AND dataset_key IN ('session_content', 'review_payloads')`, [tenantId, value.privacyRetentionPolicyId]);
      const policy = policyResult.rows[0];
      if (!policy) throw new ConflictException("An approved Runtime-owned retention policy is required.");
      const cutoff = new Date(Date.now() - Number(policy.retention_days) * 86_400_000);
      const candidates = await client.query<{ session_id: string; subject_reference_digest: string | null; held: boolean; cleanup_safe: boolean }>(
        `SELECT s.session_id, b.subject_reference_digest,
           EXISTS (SELECT 1 FROM ${schema}.privacy_legal_holds h
             WHERE h.customer_id = s.customer_id AND h.subject_reference_digest = b.subject_reference_digest
               AND h.status = 'active') AS held,
           NOT EXISTS (SELECT 1 FROM ${schema}.provider_session_allocations a
             WHERE a.customer_id = s.customer_id AND a.session_id = s.session_id
               AND a.stage <> 'released' AND NOT (a.stage = 'failed' AND a.provider_snapshot = '{}'::jsonb)) AS cleanup_safe
         FROM ${schema}.sessions s
         LEFT JOIN LATERAL (
           SELECT subject_reference_digest FROM ${schema}.privacy_subject_bindings b
           WHERE b.customer_id = s.customer_id AND b.session_id = s.session_id
           ORDER BY b.created_at LIMIT 1
         ) b ON true
         WHERE s.customer_id = $1 AND s.status IN ('closed', 'failed') AND s.ended_at < $2
         ORDER BY s.ended_at, s.session_id LIMIT $3`, [tenantId, cutoff.toISOString(), value.limit]);
      const held = candidates.rows.filter((row) => row.held);
      const unbound = candidates.rows.filter((row) => !row.subject_reference_digest);
      const unsafe = candidates.rows.filter((row) => !row.cleanup_safe);
      const eligible = candidates.rows.filter((row) => row.subject_reference_digest && !row.held && row.cleanup_safe).map((row) => row.session_id);
      let processed = 0;
      if (value.execute && eligible.length) {
        if (policy.dataset_key === "session_content") {
          const outcome = await this.redactSessionContent(client, schema, tenantId, eligible);
          processed = outcome.counts?.sessions ?? 0;
        } else {
          const outcome = await this.redactReviewPayloads(client, schema, tenantId, eligible);
          processed = outcome.counts?.reviews ?? 0;
        }
      }
      const evidence = {
        policyId: policy.privacy_retention_policy_id, datasetKey: policy.dataset_key,
        cutoffAt: cutoff.toISOString(), execute: value.execute, candidateCount: candidates.rows.length,
        eligibleCount: eligible.length, heldCount: held.length, unboundCount: unbound.length,
        unsafeCleanupCount: unsafe.length, processedCount: processed,
      };
      const status = unbound.length || unsafe.length ? "blocked" : value.execute ? "completed" : "previewed";
      const created = await client.query<{ privacy_retention_run_id: string }>(
        `INSERT INTO ${schema}.privacy_retention_runs
          (customer_id, privacy_retention_policy_id, dataset_key, status, cutoff_at, execute_requested,
           candidate_count, held_count, unbound_count, unsafe_cleanup_count, processed_count, outcome_digest, created_by_identity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING privacy_retention_run_id`,
        [tenantId, policy.privacy_retention_policy_id, policy.dataset_key, status, cutoff.toISOString(), value.execute,
          candidates.rows.length, held.length, unbound.length, unsafe.length, processed, digest(evidence), actorId]);
      return { privacyRetentionRunId: created.rows[0].privacy_retention_run_id, status, ...evidence };
    });
  }

  private async lockExecutableRequest(client: PoolClient, schema: string, tenantId: string, requestId: string) {
    const request = await this.requestForUpdate(client, schema, tenantId, requestId);
    if (request.verification_status !== "verified") throw new ConflictException("The subject request must be verified before execution.");
    const stale = request.status === "processing" && request.processing_started_at
      && Date.now() - new Date(request.processing_started_at).getTime() > 15 * 60_000;
    if (!["ready", "blocked"].includes(request.status) && !stale) throw new ConflictException("The subject request is not executable.");
    return request;
  }

  private async requestForUpdate(client: PoolClient, schema: string, tenantId: string, requestId: string) {
    const result = await client.query<RequestRow>(
      `SELECT privacy_subject_request_id, request_type, subject_reference_digest, selectors,
              verification_status, status, processing_started_at
       FROM ${schema}.privacy_subject_requests
       WHERE customer_id = $1 AND privacy_subject_request_id = $2 FOR UPDATE`, [tenantId, requestId]);
    if (!result.rows[0]) throw new NotFoundException("Privacy subject request not found.");
    return result.rows[0];
  }

  private async assertNoHold(client: PoolClient, schema: string, tenantId: string, subjectDigest: string) {
    const hold = await client.query(
      `SELECT 1 FROM ${schema}.privacy_legal_holds
       WHERE customer_id = $1 AND subject_reference_digest = $2 AND status = 'active' LIMIT 1`, [tenantId, subjectDigest]);
    if (hold.rows[0]) throw new ConflictException("Privacy execution is blocked by an active legal hold.");
  }

  private async redactRuntime(client: PoolClient, schema: string, tenantId: string, sessionIds: string[]) {
    return {
      sessionContent: await this.redactSessionContent(client, schema, tenantId, sessionIds),
      reviewPayloads: await this.redactReviewPayloads(client, schema, tenantId, sessionIds),
      operationalMetadata: await this.redactOperationalMetadata(client, schema, tenantId, sessionIds),
    };
  }

  private async redactSessionContent(client: PoolClient, schema: string, tenantId: string, sessionIds: string[]): Promise<TargetOutcome> {
    const tools = await client.query(
      `UPDATE ${schema}.tool_calls SET input = '{"redacted":true}'::jsonb,
         output = CASE WHEN output IS NULL THEN NULL ELSE '{"redacted":true}'::jsonb END,
         error_message = NULL, provider_call_id = NULL, provider_event_id = NULL
       WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) RETURNING tool_call_id`, [tenantId, sessionIds]);
    const events = await client.query(
      `UPDATE ${schema}.events SET payload = '{"redacted":true}'::jsonb
       WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) RETURNING event_id`, [tenantId, sessionIds]);
    const notes = await client.query(
      `UPDATE ${schema}.conversation_operator_notes SET note_text = '[privacy redacted]'
       WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) AND note_text <> '[privacy redacted]'
       RETURNING conversation_operator_note_id`, [tenantId, sessionIds]);
    const sessions = await client.query(
      `UPDATE ${schema}.sessions SET created_by_user_id = NULL, provider_session_id = NULL,
         avatar_session_id = NULL, metadata = '{"privacyRedacted":true}'::jsonb, updated_at = now()
       WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) RETURNING session_id`, [tenantId, sessionIds]);
    const counts = { sessions: sessions.rowCount ?? 0, toolCalls: tools.rowCount ?? 0,
      events: events.rowCount ?? 0, operatorNotes: notes.rowCount ?? 0 };
    return completed("runtime_transaction", "runtime:session-content:redacted", counts,
      "Session metadata and content payloads were de-identified; schema-limited usage evidence remains linked to the de-identified session row.");
  }

  private async redactReviewPayloads(client: PoolClient, schema: string, tenantId: string, sessionIds: string[]): Promise<TargetOutcome> {
    const reviews = await client.query(
      `UPDATE ${schema}.action_reviews SET payload = '{}'::jsonb, payload_hash = 'privacy-redacted', updated_at = now()
       WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) RETURNING review_id`, [tenantId, sessionIds]);
    const counts = { reviews: reviews.rowCount ?? 0 };
    return completed("runtime_transaction", "runtime:review-payloads:redacted", counts,
      "Review payloads were removed while command/status evidence was retained.");
  }

  private async redactOperationalMetadata(client: PoolClient, schema: string, tenantId: string, sessionIds: string[]): Promise<TargetOutcome> {
    const allocations = await client.query(
      `UPDATE ${schema}.provider_session_allocations SET provider_snapshot = '{}'::jsonb,
         last_error_message = NULL, updated_at = now()
       WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) RETURNING allocation_id`, [tenantId, sessionIds]);
    const escalations = await client.query(
      `UPDATE ${schema}.escalation_cases SET summary = '[privacy redacted]', contact_preference = NULL,
         resolution_note = NULL, updated_at = now()
       WHERE customer_id = $1 AND source_session_id = ANY($2::uuid[]) RETURNING escalation_case_id`, [tenantId, sessionIds]);
    if ((escalations.rowCount ?? 0) > 0) await client.query(
      `UPDATE ${schema}.escalation_case_events e SET metadata = '{}'::jsonb
       FROM ${schema}.escalation_cases c
       WHERE e.customer_id = $1 AND e.escalation_case_id = c.escalation_case_id
         AND c.source_session_id = ANY($2::uuid[])`, [tenantId, sessionIds]);
    const counts = { providerAllocations: allocations.rowCount ?? 0, escalations: escalations.rowCount ?? 0 };
    return completed("runtime_transaction", "runtime:operational-metadata:redacted", counts,
      "Provider snapshots, raw errors and escalation subject content were removed; operational state and timestamps were retained.");
  }

  private async accessRuntime(client: PoolClient, schema: string, tenantId: string, sessionIds: string[]) {
    const sessions = await bounded(client, `SELECT session_id, status, ai_provider, avatar_provider, metadata,
      started_at, ended_at FROM ${schema}.sessions WHERE customer_id = $1 AND session_id = ANY($2::uuid[])
      ORDER BY started_at`, [tenantId, sessionIds]);
    const tools = await bounded(client, `SELECT tool_call_id, session_id, tool_name, status, input, output,
      error_code, started_at, completed_at FROM ${schema}.tool_calls
      WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) ORDER BY created_at`, [tenantId, sessionIds]);
    const reviews = await bounded(client, `SELECT review_id, session_id, action_type, payload, status,
      confirmed_at, committed_at, created_at FROM ${schema}.action_reviews
      WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) ORDER BY created_at`, [tenantId, sessionIds]);
    const events = await bounded(client, `SELECT event_id, session_id, event_type, payload, created_at
      FROM ${schema}.events WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) ORDER BY created_at`, [tenantId, sessionIds]);
    const notes = await bounded(client, `SELECT conversation_operator_note_id, session_id, note_text,
      created_by_identity, created_at FROM ${schema}.conversation_operator_notes
      WHERE customer_id = $1 AND session_id = ANY($2::uuid[]) ORDER BY created_at`, [tenantId, sessionIds]);
    return { sessions: sessions.map((row) => ({ ...row, metadata: safeAccessValue(row.metadata) })),
      toolCalls: tools, reviews, events, operatorNotes: notes };
  }

  private async processBusinessManager(requestType: "access" | "deletion", commandIds: string[]): Promise<{
    outcome: TargetOutcome; document?: unknown;
  }> {
    if (!commandIds.length) return {
      outcome: notApplicable("owner_api", "business-manager:no-linked-commands",
        "No committed Business Manager command is linked to the selected sessions."),
    };
    if (!this.businessManager) return { outcome: blocked("business-manager:adapter-unavailable", "Business Manager privacy adapter is unavailable.") };
    try {
      if (requestType === "access") {
        const result = await this.businessManager.getPrivacySubjectData(commandIds);
        return { document: result.document, outcome: {
          status: "completed", verificationMethod: "owner_api", evidenceReference: "business-manager:privacy-access",
          evidenceDigest: result.digest, detail: "Business Manager returned a scoped subject-data snapshot.",
          counts: { bookings: result.document.bookings.length },
        } };
      }
      const result = await this.businessManager.redactPrivacySubjectData(commandIds);
      return { outcome: {
        status: "completed", verificationMethod: "owner_api", evidenceReference: "business-manager:privacy-redaction",
        evidenceDigest: result.digest, detail: "Business Manager de-identified linked booking and delivery records.", counts: result.counts,
      } };
    } catch {
      return { outcome: blocked("business-manager:owner-api-failed",
        "Business Manager did not return verifiable privacy-operation evidence; the target remains blocked.") };
    }
  }

  private async providerOutcome(client: PoolClient, schema: string, tenantId: string, providers: string[], requestId: string): Promise<TargetOutcome> {
    if (!providers.length) return notApplicable("approved_not_stored", `privacy-request:${requestId}:no-provider`, "No provider owner was recorded.");
    const flows = await client.query<{ owner_key: string; deletion_control: string }>(
      `SELECT owner_key, deletion_control FROM ${schema}.privacy_data_flows
       WHERE customer_id = $1 AND owner_key = ANY($2::text[]) AND status = 'approved'`, [tenantId, providers]);
    const byOwner = new Map(flows.rows.map((row) => [row.owner_key, row.deletion_control]));
    if (providers.some((provider) => byOwner.get(provider) !== "not_stored")) {
      return blocked(`privacy-request:${requestId}:provider-evidence`,
        "Every selected provider needs an approved not-stored assessment or separate owner deletion evidence.");
    }
    return notApplicable("approved_not_stored", `privacy-request:${requestId}:provider-not-stored`,
      "Approved data-flow records state that the selected providers do not retain this application data.");
  }

  private async setTarget(client: PoolClient, schema: string, tenantId: string, requestId: string,
    targetKey: string, outcome: TargetOutcome, actorId: string) {
    const updated = await client.query(
      `UPDATE ${schema}.privacy_subject_request_targets SET status = $4, evidence_reference = $5,
         evidence_digest = $6, detail = $7, result_counts = $8::jsonb, verification_method = $9,
         updated_by_identity = $10, updated_at = now()
       WHERE customer_id = $1 AND privacy_subject_request_id = $2 AND target_key = $3
         AND status NOT IN ('completed', 'not_applicable') RETURNING privacy_subject_request_target_id`,
      [tenantId, requestId, targetKey, outcome.status, outcome.evidenceReference, outcome.evidenceDigest,
        outcome.detail, JSON.stringify(outcome.counts ?? {}), outcome.verificationMethod, actorId]);
    if (updated.rows[0]) await this.event(client, schema, tenantId, requestId,
      outcome.status === "blocked" ? "target_blocked" : "target_completed", actorId,
      { targetKey, status: outcome.status, evidenceDigest: outcome.evidenceDigest });
  }

  private async finalize(client: PoolClient, schema: string, tenantId: string, requestId: string, actorId: string) {
    const result = await client.query<{
      target_key: string; status: string; evidence_digest: string | null; detail: string | null;
    }>(`SELECT target_key, status, evidence_digest, detail FROM ${schema}.privacy_subject_request_targets
        WHERE customer_id = $1 AND privacy_subject_request_id = $2 ORDER BY target_key`, [tenantId, requestId]);
    const complete = result.rows.every((row) => ["completed", "not_applicable"].includes(row.status));
    const status = complete ? "completed" : "blocked";
    const outcomeDigest = digest(result.rows);
    await client.query(
      `UPDATE ${schema}.privacy_subject_requests SET status = $3, outcome_digest = $4,
         completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE NULL END, processing_started_at = NULL
       WHERE customer_id = $1 AND privacy_subject_request_id = $2`, [tenantId, requestId, status, outcomeDigest]);
    await this.event(client, schema, tenantId, requestId, complete ? "completed" : "blocked", actorId,
      { outcomeDigest, incompleteTargets: result.rows.filter((row) => !["completed", "not_applicable"].includes(row.status)).map((row) => row.target_key) });
    return { status, outcomeDigest, targets: result.rows };
  }

  private event(client: PoolClient, schema: string, tenantId: string, requestId: string,
    eventType: string, actorId: string, metadata: Record<string, unknown> = {}) {
    return client.query(
      `INSERT INTO ${schema}.privacy_subject_request_events
        (customer_id, privacy_subject_request_id, event_type, actor_identity, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`, [tenantId, requestId, eventType, actorId, JSON.stringify(metadata)]);
  }
}

async function bounded(client: PoolClient, sql: string, params: unknown[]) {
  const result = await client.query(`${sql} LIMIT 5001`, params);
  if (result.rows.length > 5000) throw new ConflictException("The access result exceeds 5,000 rows; narrow the subject request.");
  return result.rows;
}

function completed(method: TargetOutcome["verificationMethod"], reference: string, counts: Record<string, number>, detail: string): TargetOutcome {
  return { status: "completed", verificationMethod: method, evidenceReference: reference,
    evidenceDigest: digest({ counts, detail }), detail, counts };
}
function notApplicable(method: TargetOutcome["verificationMethod"], reference: string, detail: string): TargetOutcome {
  return { status: "not_applicable", verificationMethod: method, evidenceReference: reference,
    evidenceDigest: digest({ status: "not_applicable", detail }), detail };
}
function blocked(reference: string, detail: string): TargetOutcome {
  return { status: "blocked", verificationMethod: "system_evaluation", evidenceReference: reference,
    evidenceDigest: digest({ status: "blocked", detail }), detail };
}
function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") { const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`; }
  return JSON.stringify(value) ?? "null";
}
function safeAccessValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(safeAccessValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, child]) => [key,
    /token|secret|authorization|credential|meeting/i.test(key) ? "[REDACTED]" : safeAccessValue(child)]));
}
