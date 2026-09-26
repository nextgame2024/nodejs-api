import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AgentDraftConfigurationSchema, type PublicationCheck } from "../agents/agent-authoring.contracts.js";
import { AGENT_PUBLICATION_CHECK_IDS, runAgentPublicationChecks } from "../agents/agent-publication-checks.js";
import {
  BindEvaluationRequirementSchema,
  CreateEvaluationDatasetSchema,
  CreateEvaluationVersionSchema,
  EVALUATOR_KEY,
  EVALUATOR_VERSION,
  EVIDENCE_MODE,
  RunEvaluationSchema,
  type EvaluationCase,
} from "./evaluation.contracts.js";

type VersionRow = {
  evaluation_dataset_version_id: string; evaluation_dataset_id: string; version: number; status: string;
  evaluator_key: string; evaluator_version: number; evidence_mode: string; cases: unknown;
};

@Injectable()
export class EvaluationService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  registry() {
    return {
      evaluatorKey: EVALUATOR_KEY,
      evaluatorVersion: EVALUATOR_VERSION,
      evidenceMode: EVIDENCE_MODE,
      supportedPublicationChecks: AGENT_PUBLICATION_CHECK_IDS,
      externalEffects: false,
      meteredSessionCreated: false,
      liveProviderRuns: { available: false, reason: "Authority, data-policy and budget gates are not configured." },
    };
  }

  async list(tenantId: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const [datasets, requirements, runs, releases] = await Promise.all([
        client.query(
          `SELECT d.evaluation_dataset_id, d.dataset_key, d.display_name, d.created_at,
                  COALESCE(jsonb_agg(jsonb_build_object(
                    'evaluationDatasetVersionId', v.evaluation_dataset_version_id,
                    'version', v.version, 'status', v.status, 'evaluatorKey', v.evaluator_key,
                    'evaluatorVersion', v.evaluator_version, 'evidenceMode', v.evidence_mode,
                    'cases', v.cases, 'approvedAt', v.approved_at, 'createdAt', v.created_at
                  ) ORDER BY v.version DESC) FILTER (WHERE v.evaluation_dataset_version_id IS NOT NULL), '[]'::jsonb) AS versions
           FROM ${schema}.evaluation_datasets d
           LEFT JOIN ${schema}.evaluation_dataset_versions v ON v.evaluation_dataset_id = d.evaluation_dataset_id
           WHERE d.customer_id = $1 GROUP BY d.evaluation_dataset_id ORDER BY d.dataset_key`, [tenantId]),
        client.query(
          `SELECT r.agent_evaluation_requirement_id, r.agent_id, a.agent_key,
                  r.evaluation_dataset_version_id, d.dataset_key, v.version,
                  r.required_for_publication, r.created_at
           FROM ${schema}.agent_evaluation_requirements r
           JOIN ${schema}.agents a ON a.agent_id = r.agent_id
           JOIN ${schema}.evaluation_dataset_versions v ON v.evaluation_dataset_version_id = r.evaluation_dataset_version_id
           JOIN ${schema}.evaluation_datasets d ON d.evaluation_dataset_id = v.evaluation_dataset_id
           WHERE r.customer_id = $1 ORDER BY a.agent_key, d.dataset_key`, [tenantId]),
        client.query(
          `SELECT r.evaluation_run_id, r.agent_id, a.agent_key, r.evaluation_dataset_version_id,
                  d.dataset_key, v.version, r.target_type, r.target_draft_revision, r.target_release_id,
                  r.evaluator_key, r.evaluator_version, r.evidence_mode, r.status, r.results,
                  r.external_effects, r.metered_session_created, r.run_by_identity, r.completed_at
           FROM ${schema}.evaluation_runs r
           JOIN ${schema}.agents a ON a.agent_id = r.agent_id
           JOIN ${schema}.evaluation_dataset_versions v ON v.evaluation_dataset_version_id = r.evaluation_dataset_version_id
           JOIN ${schema}.evaluation_datasets d ON d.evaluation_dataset_id = v.evaluation_dataset_id
           WHERE r.customer_id = $1 ORDER BY r.completed_at DESC LIMIT 100`, [tenantId]),
        client.query(
          `SELECT r.agent_release_id, r.agent_id, a.agent_key, r.release_number,
                  r.source_draft_revision, r.manifest_digest, r.published_at
           FROM ${schema}.agent_release_manifests r
           JOIN ${schema}.agents a ON a.agent_id = r.agent_id
           LEFT JOIN ${schema}.agent_release_revocations x ON x.agent_release_id = r.agent_release_id
           WHERE r.customer_id = $1 AND x.agent_release_id IS NULL
           ORDER BY a.agent_key, r.release_number DESC`, [tenantId]),
      ]);
      return { registry: this.registry(), datasets: datasets.rows, requirements: requirements.rows, runs: runs.rows, releases: releases.rows };
    });
  }

  async createDataset(tenantId: string, actorId: string, input: unknown) {
    const parsed = CreateEvaluationDatasetSchema.parse(input); const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<{ evaluation_dataset_id: string }>(
      `INSERT INTO ${schema}.evaluation_datasets (customer_id, dataset_key, display_name, created_by_identity)
       VALUES ($1, $2, $3, $4) RETURNING evaluation_dataset_id`,
      [tenantId, parsed.datasetKey, parsed.displayName, actorId],
    ));
    return { evaluationDatasetId: result.rows[0].evaluation_dataset_id, ...parsed };
  }

  async createVersion(tenantId: string, datasetId: string, actorId: string, input: unknown) {
    const parsed = CreateEvaluationVersionSchema.parse(input); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const owner = await client.query(`SELECT 1 FROM ${schema}.evaluation_datasets WHERE evaluation_dataset_id = $1 AND customer_id = $2 FOR UPDATE`, [datasetId, tenantId]);
      if (owner.rowCount !== 1) throw new NotFoundException("Evaluation dataset not found.");
      const result = await client.query<{ evaluation_dataset_version_id: string; version: number }>(
        `INSERT INTO ${schema}.evaluation_dataset_versions
           (evaluation_dataset_id, customer_id, version, evaluator_key, evaluator_version, evidence_mode, cases, created_by_identity)
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, $5, $6::jsonb, $7
         FROM ${schema}.evaluation_dataset_versions WHERE evaluation_dataset_id = $1
         RETURNING evaluation_dataset_version_id, version`,
        [datasetId, tenantId, EVALUATOR_KEY, EVALUATOR_VERSION, EVIDENCE_MODE, JSON.stringify(parsed.cases), actorId],
      );
      return { evaluationDatasetVersionId: result.rows[0].evaluation_dataset_version_id, version: result.rows[0].version, status: "draft" as const };
    });
  }

  async approveVersion(tenantId: string, versionId: string, actorId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.evaluation_dataset_versions SET status = 'approved', approved_by_identity = $3, approved_at = now()
       WHERE evaluation_dataset_version_id = $1 AND customer_id = $2 AND status = 'draft'
       RETURNING evaluation_dataset_version_id`, [versionId, tenantId, actorId],
    ));
    if (result.rowCount !== 1) throw new ConflictException("Evaluation version is unavailable or already approved.");
    return { evaluationDatasetVersionId: versionId, status: "approved" as const };
  }

  async bindRequirement(tenantId: string, actorId: string, input: unknown) {
    const parsed = BindEvaluationRequirementSchema.parse(input); const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `INSERT INTO ${schema}.agent_evaluation_requirements
         (customer_id, agent_id, evaluation_dataset_version_id, required_for_publication, configured_by_identity)
       SELECT $1, $2, $3, $4, $5
       WHERE EXISTS (SELECT 1 FROM ${schema}.agents WHERE agent_id = $2 AND customer_id = $1)
         AND EXISTS (SELECT 1 FROM ${schema}.evaluation_dataset_versions WHERE evaluation_dataset_version_id = $3 AND customer_id = $1 AND status = 'approved')
       ON CONFLICT (agent_id, evaluation_dataset_version_id) DO UPDATE
         SET required_for_publication = EXCLUDED.required_for_publication, configured_by_identity = EXCLUDED.configured_by_identity
       RETURNING agent_evaluation_requirement_id`,
      [tenantId, parsed.agentId, parsed.datasetVersionId, parsed.requiredForPublication, actorId],
    ));
    if (result.rowCount !== 1) throw new NotFoundException("Approved evaluation version or agent not found.");
    return { requirementId: result.rows[0].agent_evaluation_requirement_id, ...parsed };
  }

  async run(tenantId: string, actorId: string, input: unknown) {
    const parsed = RunEvaluationSchema.parse(input); const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const version = await this.loadVersion(client, schema, tenantId, parsed.datasetVersionId);
      if (version.status !== "approved") throw new ConflictException("Only approved evaluation versions can run.");
      const cases = CreateEvaluationVersionSchema.shape.cases.parse(version.cases);
      const target = parsed.target.type === "draft"
        ? await client.query<{ revision: number; configuration: unknown }>(
          `SELECT d.revision, d.configuration FROM ${schema}.agent_drafts d JOIN ${schema}.agents a ON a.agent_id = d.agent_id
           WHERE d.agent_id = $1 AND a.customer_id = $2`, [parsed.agentId, tenantId])
        : await client.query<{ revision: number; configuration: unknown }>(
          `SELECT r.source_draft_revision AS revision, r.manifest->'configuration' AS configuration
           FROM ${schema}.agent_release_manifests r WHERE r.agent_release_id = $1 AND r.agent_id = $2 AND r.customer_id = $3`,
          [parsed.target.releaseId, parsed.agentId, tenantId]);
      const row = target.rows[0]; if (!row) throw new NotFoundException("Evaluation target not found.");
      const configuration = AgentDraftConfigurationSchema.parse(row.configuration);
      const publicationChecks = await runAgentPublicationChecks(client, schema, tenantId, configuration);
      const results = evaluateCases(cases, publicationChecks);
      const status = results.every((item) => item.status === "passed") ? "passed" : "failed";
      const inserted = await client.query<{ evaluation_run_id: string }>(
        `INSERT INTO ${schema}.evaluation_runs
           (customer_id, agent_id, evaluation_dataset_version_id, target_type, target_draft_revision, target_release_id,
            evaluator_key, evaluator_version, evidence_mode, status, results, configuration_digest, run_by_identity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13) RETURNING evaluation_run_id`,
        [tenantId, parsed.agentId, parsed.datasetVersionId, parsed.target.type,
          parsed.target.type === "draft" ? row.revision : null,
          parsed.target.type === "release" ? parsed.target.releaseId : null,
          EVALUATOR_KEY, EVALUATOR_VERSION, EVIDENCE_MODE, status, JSON.stringify(results), digest(configuration), actorId],
      );
      return { evaluationRunId: inserted.rows[0].evaluation_run_id, status, evidenceMode: EVIDENCE_MODE,
        evaluatorKey: EVALUATOR_KEY, evaluatorVersion: EVALUATOR_VERSION, externalEffects: false,
        meteredSessionCreated: false, results };
    });
  }

  async publicationChecks(client: PoolClient, schema: string, tenantId: string, agentId: string, draftRevision: number): Promise<PublicationCheck[]> {
    const requirements = await client.query<{ evaluation_dataset_version_id: string; dataset_key: string; version: number; evaluator_version: number }>(
      `SELECT r.evaluation_dataset_version_id, d.dataset_key, v.version, v.evaluator_version
       FROM ${schema}.agent_evaluation_requirements r
       JOIN ${schema}.evaluation_dataset_versions v ON v.evaluation_dataset_version_id = r.evaluation_dataset_version_id
       JOIN ${schema}.evaluation_datasets d ON d.evaluation_dataset_id = v.evaluation_dataset_id
       WHERE r.customer_id = $1 AND r.agent_id = $2 AND r.required_for_publication = true AND v.status = 'approved'`,
      [tenantId, agentId],
    );
    return Promise.all(requirements.rows.map(async (requirement) => {
      const latest = await client.query<{ status: string; evidence_mode: string }>(
        `SELECT status, evidence_mode FROM ${schema}.evaluation_runs
         WHERE customer_id = $1 AND agent_id = $2 AND evaluation_dataset_version_id = $3
           AND target_type = 'draft' AND target_draft_revision = $4
           AND evaluator_key = $5 AND evaluator_version = $6
         ORDER BY completed_at DESC LIMIT 1`,
        [tenantId, agentId, requirement.evaluation_dataset_version_id, draftRevision, EVALUATOR_KEY, requirement.evaluator_version],
      );
      const evidence = latest.rows[0]; const passed = evidence?.status === "passed" && evidence.evidence_mode === EVIDENCE_MODE;
      return { checkId: `evaluation.${requirement.dataset_key}.v${requirement.version}`, status: passed ? "passed" : evidence ? "failed" : "blocked",
        message: passed
          ? `Required deterministic evaluation ${requirement.dataset_key} v${requirement.version} passed for draft revision ${draftRevision}.`
          : evidence
            ? `Required deterministic evaluation ${requirement.dataset_key} v${requirement.version} did not pass for this draft revision.`
            : `Required deterministic evaluation ${requirement.dataset_key} v${requirement.version} has not run for draft revision ${draftRevision}.` } as PublicationCheck;
    }));
  }

  private async loadVersion(client: PoolClient, schema: string, tenantId: string, versionId: string): Promise<VersionRow> {
    const result = await client.query<VersionRow>(
      `SELECT * FROM ${schema}.evaluation_dataset_versions WHERE evaluation_dataset_version_id = $1 AND customer_id = $2`,
      [versionId, tenantId],
    );
    if (!result.rows[0]) throw new NotFoundException("Evaluation version not found.");
    return result.rows[0];
  }
}

function evaluateCases(cases: EvaluationCase[], checks: PublicationCheck[]) {
  const byId = new Map(checks.map((check) => [check.checkId, check]));
  return cases.map((testCase) => {
    const actual = byId.get(testCase.publicationCheckId);
    return { caseKey: testCase.caseKey, publicationCheckId: testCase.publicationCheckId,
      expectedStatus: testCase.expectedStatus, actualStatus: actual?.status ?? "blocked",
      status: actual?.status === testCase.expectedStatus ? "passed" : "failed",
      message: actual?.message ?? "Publication check did not produce evidence." };
  });
}

function digest(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
