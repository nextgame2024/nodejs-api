import type { PoolClient } from "pg";
import type { AgentDraftConfiguration, PublicationCheck } from "./agent-authoring.contracts.js";
import { PLATFORM_SAFETY_POLICY_VERSION } from "./agent-authoring.contracts.js";

export const AGENT_PUBLICATION_CHECK_IDS = [
  "instruction.approved",
  "business_profile.published",
  "experiences.published",
  "capabilities.granted",
  "knowledge.published",
  "workflows.registered",
  "escalation.registered",
  "platform_safety.fixed",
] as const;

export async function runAgentPublicationChecks(
  client: PoolClient,
  schema: string,
  tenantId: string,
  draft: AgentDraftConfiguration,
): Promise<PublicationCheck[]> {
  const checks: PublicationCheck[] = [];
  checks.push(await existsCheck(client,
    `SELECT 1 FROM ${schema}.instruction_revisions r JOIN ${schema}.instruction_sets s ON s.instruction_set_id = r.instruction_set_id
     WHERE r.instruction_revision_id = $1 AND s.customer_id = $2 AND r.status = 'approved'`,
    [draft.instructionRevisionId, tenantId], "instruction.approved", "Approved tenant instruction revision"));
  checks.push(await existsCheck(client,
    `SELECT 1 FROM ${schema}.business_profile_versions v JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
     WHERE v.business_profile_version_id = $1 AND p.customer_id = $2 AND v.status = 'published'`,
    [draft.businessProfileVersionId, tenantId], "business_profile.published", "Published tenant business profile"));
  checks.push(await countCheck(client,
    `SELECT count(*)::int AS count FROM ${schema}.experience_profile_versions v
     JOIN ${schema}.experience_profiles p ON p.experience_profile_id = v.experience_profile_id
     WHERE v.experience_profile_version_id = ANY($1::uuid[]) AND p.customer_id = $2 AND v.status = 'published'`,
    [draft.experienceProfileVersionIds, tenantId], draft.experienceProfileVersionIds.length,
    "experiences.published", "Published tenant experience profiles"));
  checks.push(await countCheck(client,
    `SELECT count(*)::int AS count FROM ${schema}.capability_bindings b
     LEFT JOIN ${schema}.connector_bindings c ON c.connector_binding_id = b.connector_binding_id
     WHERE b.capability_binding_id = ANY($1::uuid[]) AND b.business_profile_version_id = $2
       AND b.enabled = true AND (b.connector_binding_id IS NULL OR c.status = 'active')`,
    [draft.capabilityBindingIds, draft.businessProfileVersionId], draft.capabilityBindingIds.length,
    "capabilities.granted", "Capability bindings within the business profile"));
  checks.push(await countCheck(client,
    `SELECT count(*)::int AS count FROM ${schema}.knowledge_source_revisions r
     JOIN ${schema}.knowledge_sources s ON s.knowledge_source_id = r.knowledge_source_id
     JOIN ${schema}.knowledge_snapshots x ON x.knowledge_revision_id = r.knowledge_revision_id
     WHERE r.knowledge_revision_id = ANY($1::uuid[]) AND r.customer_id = $2
       AND r.status = 'published' AND r.ingestion_status = 'ready'
       AND s.status = 'active' AND x.status = 'published'`,
    [draft.knowledgeRevisionIds, tenantId], draft.knowledgeRevisionIds.length,
    "knowledge.published", "Published tenant knowledge revisions"));
  checks.push(await countCheck(client,
    `SELECT count(*)::int AS count FROM ${schema}.workflow_versions
     WHERE workflow_version_id = ANY($1::uuid[]) AND customer_id = $2 AND status = 'published'`,
    [draft.workflowVersionIds, tenantId], draft.workflowVersionIds.length,
    "workflows.registered", "Published tenant workflow versions"));
  checks.push(await countCheck(client,
    `SELECT count(*)::int AS count FROM ${schema}.escalation_policy_versions
     WHERE escalation_policy_version_id = ANY($1::uuid[]) AND customer_id = $2 AND status = 'published'`,
    [draft.escalationPolicyVersionId ? [draft.escalationPolicyVersionId] : [], tenantId],
    draft.escalationPolicyVersionId ? 1 : 0,
    "escalation.registered", "Published tenant escalation policy"));
  checks.push({ checkId: "platform_safety.fixed", status: "passed",
    message: `Platform safety policy ${PLATFORM_SAFETY_POLICY_VERSION} is fixed outside tenant instructions.` });
  return checks;
}

async function existsCheck(client: PoolClient, sql: string, params: unknown[], checkId: string, label: string): Promise<PublicationCheck> {
  const result = await client.query(sql, params);
  return result.rowCount === 1
    ? { checkId, status: "passed", message: `${label} verified.` }
    : { checkId, status: "failed", message: `${label} is missing, unpublished or cross-tenant.` };
}

async function countCheck(client: PoolClient, sql: string, params: unknown[], expected: number, checkId: string, label: string): Promise<PublicationCheck> {
  if (expected === 0) return { checkId, status: "passed", message: `No ${label.toLowerCase()} referenced.` };
  const result = await client.query<{ count: number }>(sql, params);
  return Number(result.rows[0]?.count ?? 0) === expected
    ? { checkId, status: "passed", message: `${label} verified.` }
    : { checkId, status: "failed", message: `${label} contain unknown or cross-tenant references.` };
}
