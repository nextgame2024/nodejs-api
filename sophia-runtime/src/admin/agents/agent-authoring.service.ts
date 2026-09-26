import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import {
  AgentDraftConfigurationSchema,
  CreateAgentSchema,
  CreateInstructionSetSchema,
  InstructionRevisionInputSchema,
  PLATFORM_SAFETY_POLICY_VERSION,
  UpdateAgentDraftSchema,
  type AgentDraftConfiguration,
  type PublicationCheck,
} from "./agent-authoring.contracts.js";
import type { AdminPermission } from "../permissions/admin-permissions.js";
import { ProviderCapabilityManifestSchema } from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";
import { runAgentPublicationChecks } from "./agent-publication-checks.js";
import { EvaluationService } from "../evaluations/evaluation.service.js";

type DraftRow = { revision: number; configuration: unknown };
type DraftAndReleaseRow = DraftRow & {
  active_release_id: string | null;
  release_number: number | null;
  manifest: unknown | null;
};

@Injectable()
export class AgentAuthoringService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EvaluationService) private readonly evaluations: EvaluationService,
  ) {}

  async listAgents(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT a.agent_id, a.agent_key, a.status, a.active_release_id,
              d.revision AS draft_revision, a.created_at, a.updated_at
       FROM ${schema}.agents a
       JOIN ${schema}.agent_drafts d ON d.agent_id = a.agent_id
       WHERE a.customer_id = $1 ORDER BY a.agent_key`,
      [tenantId],
    ));
    return { agents: result.rows };
  }

  async listAuthoringDependencies(
    tenantId: string,
    permissions: readonly AdminPermission[],
  ) {
    const schema = runtimeConfig().schema;
    const grants = new Set(permissions);
    return this.database.tenantTransaction(tenantId, async (client) => {
      const [business, experienceRows, instructions, capabilities, knowledge, workflows, escalations] = await Promise.all([
        client.query(
          `SELECT v.business_profile_version_id AS "businessProfileVersionId",
                  p.profile_key AS "profileKey", p.display_name AS "displayName",
                  v.version, v.pack_registration_key AS "packRegistrationKey"
           FROM ${schema}.business_profile_versions v
           JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
           WHERE p.customer_id = $1 AND v.status = 'published'
           ORDER BY p.profile_key, v.version DESC`, [tenantId],
        ),
        client.query(
          `SELECT v.experience_profile_version_id AS "experienceProfileVersionId",
                  p.experience_key AS "experienceKey", p.display_name AS "displayName",
                  v.business_profile_version_id AS "businessProfileVersionId",
                  v.version, v.pipeline_mode AS "pipelineMode",
                  c.provider_id AS "providerId", c.adapter_key AS "adapterKey", c.manifest
           FROM ${schema}.experience_profile_versions v
           JOIN ${schema}.experience_profiles p ON p.experience_profile_id = v.experience_profile_id
           LEFT JOIN ${schema}.experience_provider_bindings b
             ON b.experience_profile_version_id = v.experience_profile_version_id
           LEFT JOIN ${schema}.provider_configurations c
             ON c.provider_configuration_id = b.provider_configuration_id
           WHERE p.customer_id = $1 AND v.status = 'published'
           ORDER BY p.experience_key, v.version DESC, b.capability_key`, [tenantId],
        ),
        grants.has("instructions.read") ? client.query(
          `SELECT r.instruction_revision_id AS "instructionRevisionId",
                  s.instruction_key AS "instructionKey", r.revision, r.status,
                  r.created_by_identity AS "createdByIdentity", r.approved_at AS "approvedAt"
           FROM ${schema}.instruction_revisions r
           JOIN ${schema}.instruction_sets s ON s.instruction_set_id = r.instruction_set_id
           WHERE s.customer_id = $1 AND r.status = 'approved'
           ORDER BY s.instruction_key, r.revision DESC`, [tenantId],
        ) : emptyRows(),
        grants.has("tools.read") ? client.query(
          `SELECT b.capability_binding_id AS "capabilityBindingId",
                  b.business_profile_version_id AS "businessProfileVersionId",
                  b.capability_key AS "capabilityKey", b.connector_key AS "connectorKey",
                  b.enabled
           FROM ${schema}.capability_bindings b
           JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id = b.business_profile_version_id
           JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
           WHERE p.customer_id = $1 AND v.status = 'published' AND b.enabled = true
           ORDER BY b.capability_key`, [tenantId],
        ) : emptyRows(),
        grants.has("knowledge.read") ? client.query(
          `SELECT r.knowledge_revision_id AS "knowledgeRevisionId",
                  s.source_key AS "sourceKey", s.title, r.revision
           FROM ${schema}.knowledge_source_revisions r
           JOIN ${schema}.knowledge_sources s ON s.knowledge_source_id = r.knowledge_source_id
           JOIN ${schema}.knowledge_snapshots x ON x.knowledge_revision_id = r.knowledge_revision_id
           WHERE r.customer_id = $1 AND r.status = 'published' AND r.ingestion_status = 'ready'
             AND s.status = 'active' AND x.status = 'published'
           ORDER BY s.source_key, r.revision DESC`, [tenantId],
        ) : emptyRows(),
        grants.has("workflows.read") ? client.query(
          `SELECT v.workflow_version_id AS "workflowVersionId", d.workflow_key AS "workflowKey",
                  v.version, v.template_key AS "templateKey", v.template_version AS "templateVersion"
           FROM ${schema}.workflow_versions v
           JOIN ${schema}.workflow_definitions d ON d.workflow_definition_id = v.workflow_definition_id
           WHERE v.customer_id = $1 AND v.status = 'published'
           ORDER BY d.workflow_key, v.version DESC`, [tenantId],
        ) : emptyRows(),
        grants.has("escalations.read") ? client.query(
          `SELECT v.escalation_policy_version_id AS "escalationPolicyVersionId",
                  p.policy_key AS "policyKey", v.version
           FROM ${schema}.escalation_policy_versions v
           JOIN ${schema}.escalation_policies p ON p.escalation_policy_id = v.escalation_policy_id
           WHERE v.customer_id = $1 AND v.status = 'published'
           ORDER BY p.policy_key, v.version DESC`, [tenantId],
        ) : emptyRows(),
      ]);
      return {
        businessProfiles: business.rows,
        experienceProfiles: groupExperiences(experienceRows.rows),
        instructionRevisions: instructions.rows,
        capabilityBindings: capabilities.rows,
        knowledgeRevisions: knowledge.rows,
        workflowVersions: workflows.rows,
        escalationPolicyVersions: escalations.rows,
        restrictedSections: [
          ["instructions", "instructions.read"],
          ["capabilities", "tools.read"],
          ["knowledge", "knowledge.read"],
          ["workflows", "workflows.read"],
          ["escalations", "escalations.read"],
        ].filter(([, permission]) => !grants.has(permission as AdminPermission)).map(([section]) => section),
      };
    });
  }

  async getAgent(tenantId: string, agentId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT a.agent_id, a.agent_key, a.status, a.active_release_id,
              d.revision AS draft_revision, d.configuration,
              d.updated_by_identity, d.updated_at
       FROM ${schema}.agents a
       JOIN ${schema}.agent_drafts d ON d.agent_id = a.agent_id
       WHERE a.agent_id = $1 AND a.customer_id = $2`,
      [agentId, tenantId],
    ));
    if (!result.rows[0]) throw new NotFoundException("Agent not found.");
    return result.rows[0];
  }

  async createAgent(tenantId: string, actorId: string, input: unknown) {
    const parsed = CreateAgentSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const created = await client.query<{ agent_id: string }>(
        `INSERT INTO ${schema}.agents (customer_id, agent_key)
         VALUES ($1, $2) RETURNING agent_id`,
        [tenantId, parsed.agentKey],
      );
      const agentId = created.rows[0].agent_id;
      await client.query(
        `INSERT INTO ${schema}.agent_drafts (
           agent_id, revision, configuration, updated_by_identity
         ) VALUES ($1, 1, $2::jsonb, $3)`,
        [agentId, JSON.stringify(parsed.configuration), actorId],
      );
      return { agentId, agentKey: parsed.agentKey, status: "draft" as const, draftRevision: 1 };
    });
  }

  async createInstructionSet(tenantId: string, input: unknown) {
    const parsed = CreateInstructionSetSchema.parse(input);
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<{ instruction_set_id: string }>(
      `INSERT INTO ${schema}.instruction_sets (customer_id, instruction_key)
       VALUES ($1, $2) RETURNING instruction_set_id`,
      [tenantId, parsed.instructionKey],
    ));
    return { instructionSetId: result.rows[0].instruction_set_id, instructionKey: parsed.instructionKey };
  }

  async listInstructionSets(tenantId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT s.instruction_set_id, s.instruction_key, s.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'instructionRevisionId', r.instruction_revision_id,
                'revision', r.revision,
                'status', r.status,
                'content', r.content,
                'tone', r.tone,
                'greeting', r.greeting,
                'variableSchema', r.variable_schema,
                'createdByIdentity', r.created_by_identity,
                'approvedAt', r.approved_at,
                'createdAt', r.created_at
              ) ORDER BY r.revision DESC) FILTER (WHERE r.instruction_revision_id IS NOT NULL), '[]'::jsonb) AS revisions
       FROM ${schema}.instruction_sets s
       LEFT JOIN ${schema}.instruction_revisions r ON r.instruction_set_id = s.instruction_set_id
       WHERE s.customer_id = $1
       GROUP BY s.instruction_set_id
       ORDER BY s.instruction_key`,
      [tenantId],
    ));
    return { instructionSets: result.rows, platformSafetyPolicyVersion: PLATFORM_SAFETY_POLICY_VERSION };
  }

  async updateDraft(tenantId: string, agentId: string, actorId: string, input: unknown) {
    const parsed = UpdateAgentDraftSchema.parse(input);
    const expectedRevision = parsed.expectedRevision;
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<{ revision: number }>(
      `UPDATE ${schema}.agent_drafts d
       SET configuration = $1::jsonb, revision = revision + 1,
           updated_by_identity = $2, updated_at = now()
       FROM ${schema}.agents a
       WHERE d.agent_id = a.agent_id AND d.agent_id = $3
         AND a.customer_id = $4 AND d.revision = $5
       RETURNING d.revision`,
      [JSON.stringify(parsed.configuration), actorId, agentId, tenantId, expectedRevision],
    ));
    if (result.rowCount !== 1) throw new ConflictException("Agent draft has changed; reload before saving.");
    return { agentId, revision: result.rows[0].revision, configuration: parsed.configuration };
  }

  async createInstructionRevision(
    tenantId: string,
    instructionSetId: string,
    actorId: string,
    input: unknown,
  ) {
    const parsed = InstructionRevisionInputSchema.parse(input);
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const owner = await client.query(
        `SELECT 1 FROM ${schema}.instruction_sets
         WHERE instruction_set_id = $1 AND customer_id = $2 FOR UPDATE`,
        [instructionSetId, tenantId],
      );
      if (owner.rowCount !== 1) throw new NotFoundException("Instruction set not found.");
      const result = await client.query<{ instruction_revision_id: string; revision: number }>(
        `INSERT INTO ${schema}.instruction_revisions (
           instruction_set_id, revision, content, tone, greeting,
           variable_schema, created_by_identity
         ) SELECT $1, COALESCE(MAX(revision), 0) + 1, $2, $3, $4, $5::jsonb, $6
           FROM ${schema}.instruction_revisions WHERE instruction_set_id = $1
         RETURNING instruction_revision_id, revision`,
        [instructionSetId, parsed.content, parsed.tone ?? null, parsed.greeting ?? null,
          JSON.stringify(parsed.variableSchema), actorId],
      );
      return { ...result.rows[0], status: "draft" as const };
    });
  }

  async approveInstructionRevision(tenantId: string, revisionId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.instruction_revisions r
       SET status = 'approved', approved_at = now()
       FROM ${schema}.instruction_sets s
       WHERE r.instruction_set_id = s.instruction_set_id
         AND r.instruction_revision_id = $1 AND s.customer_id = $2
         AND r.status = 'draft' RETURNING r.instruction_revision_id`,
      [revisionId, tenantId],
    ));
    if (result.rowCount !== 1) throw new ConflictException("Instruction revision is unavailable or already approved.");
    return { instructionRevisionId: revisionId, status: "approved" as const };
  }

  async validateDraft(tenantId: string, agentId: string): Promise<{ revision: number; checks: PublicationCheck[] }> {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const draft = await this.loadDraft(client, schema, tenantId, agentId, false);
      if (!draft) throw new NotFoundException("Agent draft not found.");
      const configuration = AgentDraftConfigurationSchema.parse(draft.configuration);
      const checks = await runAgentPublicationChecks(client, schema, tenantId, configuration);
      checks.push(...await this.evaluations.publicationChecks(client, schema, tenantId, agentId, draft.revision));
      return { revision: draft.revision, checks };
    });
  }

  async previewDraft(
    tenantId: string,
    agentId: string,
    variables: Record<string, string | number | boolean>,
  ) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const draft = await this.loadDraft(client, schema, tenantId, agentId, false);
      if (!draft) throw new NotFoundException("Agent draft not found.");
      const configuration = AgentDraftConfigurationSchema.parse(draft.configuration);
      const instruction = await client.query<{
        content: string; tone: string | null; greeting: string | null; variable_schema: unknown;
      }>(
        `SELECT r.content, r.tone, r.greeting, r.variable_schema
         FROM ${schema}.instruction_revisions r
         JOIN ${schema}.instruction_sets s ON s.instruction_set_id = r.instruction_set_id
         WHERE r.instruction_revision_id = $1 AND s.customer_id = $2`,
        [configuration.instructionRevisionId, tenantId],
      );
      const row = instruction.rows[0];
      if (!row) throw new NotFoundException("Referenced tenant instruction revision was not found.");
      const parsed = InstructionRevisionInputSchema.parse({
        content: row.content,
        ...(row.tone ? { tone: row.tone } : {}),
        ...(row.greeting ? { greeting: row.greeting } : {}),
        variableSchema: row.variable_schema,
      });
      validatePreviewVariables(parsed.variableSchema.properties, variables);
      return {
        mode: "deterministic-composition-only" as const,
        externalEffects: false,
        meteredSessionCreated: false,
        draftRevision: draft.revision,
        platformSafetyPolicyVersion: PLATFORM_SAFETY_POLICY_VERSION,
        instruction: {
          content: interpolate(parsed.content, variables),
          tone: parsed.tone ? interpolate(parsed.tone, variables) : null,
          greeting: parsed.greeting ? interpolate(parsed.greeting, variables) : null,
        },
        checks: await runAgentPublicationChecks(client, schema, tenantId, configuration),
      };
    });
  }

  async diffDraft(tenantId: string, agentId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<DraftAndReleaseRow>(
      `SELECT d.revision, d.configuration, a.active_release_id,
              r.release_number, r.manifest
       FROM ${schema}.agent_drafts d
       JOIN ${schema}.agents a ON a.agent_id = d.agent_id
       LEFT JOIN ${schema}.agent_release_manifests r ON r.agent_release_id = a.active_release_id
       WHERE d.agent_id = $1 AND a.customer_id = $2`,
      [agentId, tenantId],
    ));
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Agent draft not found.");
    const draft = AgentDraftConfigurationSchema.parse(row.configuration);
    const published = releaseConfiguration(row.manifest);
    const fields = Object.keys(draft) as Array<keyof AgentDraftConfiguration>;
    const changes = fields.flatMap((field) => {
      const draftValue = draft[field];
      const publishedValue = published?.[field] ?? null;
      return digestValue(draftValue) === digestValue(publishedValue)
        ? []
        : [{ field, publishedValue, draftValue }];
    });
    return {
      agentId,
      draftRevision: row.revision,
      activeReleaseId: row.active_release_id,
      activeReleaseNumber: row.release_number,
      changes,
    };
  }

  async listReleases(tenantId: string, agentId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT r.agent_release_id, r.release_number, r.source_draft_revision,
              r.manifest, r.manifest_digest, r.platform_safety_policy_version,
              r.release_notes, r.published_by_identity, r.published_at,
              (a.active_release_id = r.agent_release_id) AS active,
              x.reason AS revocation_reason, x.revoked_at
       FROM ${schema}.agent_release_manifests r
       JOIN ${schema}.agents a ON a.agent_id = r.agent_id
       LEFT JOIN ${schema}.agent_release_revocations x ON x.agent_release_id = r.agent_release_id
       WHERE r.agent_id = $1 AND a.customer_id = $2
       ORDER BY r.release_number DESC`,
      [agentId, tenantId],
    ));
    return { agentId, releases: result.rows };
  }

  async publishDraft(
    tenantId: string,
    agentId: string,
    actorId: string,
    expectedRevision: number,
    releaseNotes?: string,
  ) {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const draft = await this.loadDraft(client, schema, tenantId, agentId, true);
      if (!draft) throw new NotFoundException("Agent draft not found.");
      if (draft.revision !== expectedRevision) throw new ConflictException("Agent draft changed before publication.");
      const configuration = AgentDraftConfigurationSchema.parse(draft.configuration);
      const checks = await runAgentPublicationChecks(client, schema, tenantId, configuration);
      checks.push(...await this.evaluations.publicationChecks(client, schema, tenantId, agentId, draft.revision));
      if (checks.some((check) => check.status !== "passed")) {
        throw new UnprocessableEntityException({ message: "Agent release is not publishable.", checks });
      }
      const manifest = {
        schemaVersion: 1,
        agentId,
        tenantId,
        draftRevision: draft.revision,
        platformSafetyPolicyVersion: PLATFORM_SAFETY_POLICY_VERSION,
        configuration,
        workflowBindings: await this.workflowBindings(client, schema, tenantId, configuration.workflowVersionIds),
      };
      const digest = digestValue(manifest);
      const release = await client.query<{ agent_release_id: string; release_number: number }>(
        `INSERT INTO ${schema}.agent_release_manifests (
           agent_id, customer_id, release_number, source_draft_revision, manifest,
           manifest_digest, platform_safety_policy_version, release_notes,
           published_by_identity
         ) SELECT $1, $2, COALESCE(MAX(release_number), 0) + 1, $3, $4::jsonb,
                  $5, $6, $7, $8
           FROM ${schema}.agent_release_manifests WHERE agent_id = $1
         RETURNING agent_release_id, release_number`,
        [agentId, tenantId, draft.revision, JSON.stringify(manifest), digest,
          PLATFORM_SAFETY_POLICY_VERSION, releaseNotes ?? null, actorId],
      );
      await client.query(
        `UPDATE ${schema}.agents SET active_release_id = $1, status = 'enabled', updated_at = now()
         WHERE agent_id = $2 AND customer_id = $3`,
        [release.rows[0].agent_release_id, agentId, tenantId],
      );
      return { agentId, releaseId: release.rows[0].agent_release_id,
        releaseNumber: release.rows[0].release_number, manifestDigest: digest, checks };
    });
  }

  async rollback(tenantId: string, agentId: string, releaseId: string) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `UPDATE ${schema}.agents a SET active_release_id = r.agent_release_id,
                                     status = 'enabled', updated_at = now()
       FROM ${schema}.agent_release_manifests r
       LEFT JOIN ${schema}.agent_release_revocations x ON x.agent_release_id = r.agent_release_id
       WHERE a.agent_id = $1 AND a.customer_id = $2 AND r.agent_id = a.agent_id
         AND r.agent_release_id = $3 AND x.agent_release_id IS NULL
       RETURNING r.agent_release_id`,
      [agentId, tenantId, releaseId],
    ));
    if (result.rowCount !== 1) throw new ConflictException("Release is unavailable, revoked or cross-tenant.");
    return { agentId, activeReleaseId: releaseId };
  }

  async revokeRelease(
    tenantId: string,
    agentId: string,
    releaseId: string,
    actorId: string,
    reason: string,
  ) {
    if (!reason.trim() || reason.length > 2_000) {
      throw new UnprocessableEntityException("A bounded revocation reason is required.");
    }
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const release = await client.query(
        `SELECT 1 FROM ${schema}.agent_release_manifests r
         JOIN ${schema}.agents a ON a.agent_id = r.agent_id
         WHERE r.agent_release_id = $1 AND r.agent_id = $2 AND a.customer_id = $3`,
        [releaseId, agentId, tenantId],
      );
      if (release.rowCount !== 1) throw new NotFoundException("Agent release not found.");
      await client.query(
        `INSERT INTO ${schema}.agent_release_revocations (
           agent_release_id, reason, revoked_by_identity
         ) VALUES ($1, $2, $3) ON CONFLICT (agent_release_id) DO NOTHING`,
        [releaseId, reason.trim(), actorId],
      );
      await client.query(
        `UPDATE ${schema}.agents SET status = 'disabled', updated_at = now()
         WHERE agent_id = $1 AND customer_id = $2 AND active_release_id = $3`,
        [agentId, tenantId, releaseId],
      );
      return { agentId, releaseId, revoked: true };
    });
  }

  async assertReleaseUsable(tenantId: string, releaseId: string): Promise<void> {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query(
      `SELECT 1 FROM ${schema}.agent_release_manifests r
       JOIN ${schema}.agents a ON a.agent_id = r.agent_id
       LEFT JOIN ${schema}.agent_release_revocations x ON x.agent_release_id = r.agent_release_id
       WHERE r.agent_release_id = $1 AND a.customer_id = $2
         AND a.status = 'enabled' AND x.agent_release_id IS NULL`,
      [releaseId, tenantId],
    ));
    if (result.rowCount !== 1) throw new ForbiddenException("Agent release is disabled or revoked.");
  }

  private async loadDraft(client: PoolClient, schema: string, tenantId: string, agentId: string, lock: boolean) {
    const result = await client.query<DraftRow>(
      `SELECT d.revision, d.configuration FROM ${schema}.agent_drafts d
       JOIN ${schema}.agents a ON a.agent_id = d.agent_id
       WHERE d.agent_id = $1 AND a.customer_id = $2${lock ? " FOR UPDATE" : ""}`,
      [agentId, tenantId],
    );
    return result.rows[0];
  }

  private async workflowBindings(client: PoolClient, schema: string, tenantId: string, workflowVersionIds: string[]) {
    if (!workflowVersionIds.length) return [];
    const result = await client.query<{ workflow_version_id: string; template_key: string }>(
      `SELECT workflow_version_id, template_key FROM ${schema}.workflow_versions
       WHERE workflow_version_id = ANY($1::uuid[]) AND customer_id = $2 AND status = 'published'
       ORDER BY workflow_version_id`, [workflowVersionIds, tenantId],
    );
    return result.rows.map((row) => ({ workflowVersionId: row.workflow_version_id, templateKey: row.template_key }));
  }
}

function digestValue(value: unknown): string {
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

function releaseConfiguration(manifest: unknown): AgentDraftConfiguration | null {
  if (!manifest || typeof manifest !== "object") return null;
  const configuration = (manifest as { configuration?: unknown }).configuration;
  return configuration ? AgentDraftConfigurationSchema.parse(configuration) : null;
}

function emptyRows(): Promise<{ rows: never[] }> {
  return Promise.resolve({ rows: [] });
}

function groupExperiences(rows: unknown[]) {
  const profiles = new Map<string, {
    experienceProfileVersionId: string;
    experienceKey: string;
    displayName: string;
    businessProfileVersionId: string;
    version: number;
    pipelineMode: string;
    providers: Array<Record<string, unknown>>;
  }>();
  for (const candidate of rows) {
    const row = candidate as Record<string, unknown>;
    const id = String(row["experienceProfileVersionId"] ?? "");
    if (!id) continue;
    const profile = profiles.get(id) ?? {
      experienceProfileVersionId: id,
      experienceKey: String(row["experienceKey"] ?? ""),
      displayName: String(row["displayName"] ?? ""),
      businessProfileVersionId: String(row["businessProfileVersionId"] ?? ""),
      version: Number(row["version"] ?? 0),
      pipelineMode: String(row["pipelineMode"] ?? ""),
      providers: [],
    };
    const manifest = ProviderCapabilityManifestSchema.safeParse(row["manifest"]);
    const adapterKey = typeof row["adapterKey"] === "string" ? row["adapterKey"] : "";
    if (manifest.success && adapterKey && !profile.providers.some((item) => item["adapterKey"] === adapterKey)) {
      profile.providers.push({
        providerId: manifest.data.providerId,
        adapterKey,
        capabilities: manifest.data.capabilities,
        supportedModes: manifest.data.supportedModes,
        supportedInputModalities: manifest.data.supportedInputModalities,
        supportedOutputModalities: manifest.data.supportedOutputModalities,
        languages: manifest.data.languages,
        interruptionCapabilities: manifest.data.interruptionCapabilities,
        transports: manifest.data.transportAdapters,
        limitations: {
          reasoningIsReplaceable: manifest.data.reasoningIsReplaceable ?? false,
          maxSessionDuration: manifest.data.maxSessionDuration ?? null,
          toolCatalogUpdateSupport: manifest.data.toolCatalogUpdateSupport ?? "none",
          concurrencyLimits: manifest.data.concurrencyLimits ?? null,
          healthFailClosed: manifest.data.healthPolicy.failClosed,
        },
      });
    }
    profiles.set(id, profile);
  }
  return [...profiles.values()];
}

function validatePreviewVariables(
  properties: Record<string, { type: "string" | "number" | "boolean" }>,
  variables: Record<string, string | number | boolean>,
): void {
  for (const [key, value] of Object.entries(variables)) {
    const declared = properties[key];
    if (!declared) throw new BadRequestException(`Preview variable is not declared: ${key}`);
    if (typeof value !== declared.type) {
      throw new BadRequestException(`Preview variable ${key} must be ${declared.type}.`);
    }
  }
}

function interpolate(text: string, variables: Record<string, string | number | boolean>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(variables, key)) {
      throw new BadRequestException(`Preview variable is required: ${key}`);
    }
    return String(variables[key]);
  });
}
