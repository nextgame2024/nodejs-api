import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { AdminPermission } from "../permissions/admin-permissions.js";

type ReadinessRow = {
  organisation_status: string;
  active_members: number;
  pending_invitations: number;
  published_business_profiles: number;
  published_provider_configurations: number;
  published_experience_profiles: number;
  approved_instruction_revisions: number;
  published_knowledge_revisions: number;
  active_connector_bindings: number;
  enabled_capability_bindings: number;
  published_workflow_versions: number;
  published_escalation_policies: number;
  active_agent_releases: number;
  pinned_v2_sessions: number;
  audit_events: number;
};

type ReadinessStatus = "ready" | "not_configured" | "restricted" | "awaiting_runtime_evidence";
type ReadinessStep = {
  key: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  moduleIds: string[];
};

const requiredReadPermissions = [
  "organisation.read", "users.read", "agents.read", "agent_versions.read", "instructions.read",
  "knowledge.read", "tools.read", "connectors.read", "workflows.read", "permissions.read",
  "escalations.read", "audit.read",
] as const satisfies readonly AdminPermission[];

@Injectable()
export class AdminOnboardingReadinessService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async inspect(tenantId: string, permissions: readonly AdminPermission[]) {
    const schema = runtimeConfig().schema;
    const result = await this.database.tenantTransaction(tenantId, (client) => client.query<ReadinessRow>(
      `SELECT c.status AS organisation_status,
         (SELECT count(*)::int FROM ${schema}.admin_memberships m
            WHERE m.customer_id=c.customer_id AND m.status='active') AS active_members,
         (SELECT count(*)::int FROM ${schema}.admin_invitations i
            WHERE i.customer_id=c.customer_id AND i.status='pending' AND i.expires_at>now()) AS pending_invitations,
         (SELECT count(*)::int FROM ${schema}.business_profile_versions v
            JOIN ${schema}.business_profiles p ON p.business_profile_id=v.business_profile_id
            WHERE p.customer_id=c.customer_id AND v.status='published') AS published_business_profiles,
         (SELECT count(*)::int FROM ${schema}.provider_configurations p
            WHERE p.customer_id=c.customer_id AND p.status='published') AS published_provider_configurations,
         (SELECT count(*)::int FROM ${schema}.experience_profile_versions v
            JOIN ${schema}.experience_profiles p ON p.experience_profile_id=v.experience_profile_id
            WHERE p.customer_id=c.customer_id AND v.status='published') AS published_experience_profiles,
         (SELECT count(*)::int FROM ${schema}.instruction_revisions r
            JOIN ${schema}.instruction_sets s ON s.instruction_set_id=r.instruction_set_id
            WHERE s.customer_id=c.customer_id AND r.status='approved') AS approved_instruction_revisions,
         (SELECT count(DISTINCT r.knowledge_revision_id)::int FROM ${schema}.knowledge_source_revisions r
            JOIN ${schema}.knowledge_snapshots s ON s.knowledge_revision_id=r.knowledge_revision_id
            WHERE r.customer_id=c.customer_id AND r.status='published' AND s.status='published') AS published_knowledge_revisions,
         (SELECT count(*)::int FROM ${schema}.connector_bindings b
            WHERE b.customer_id=c.customer_id AND b.status='active' AND b.health_status='healthy') AS active_connector_bindings,
         (SELECT count(*)::int FROM ${schema}.capability_bindings b
            JOIN ${schema}.business_profile_versions v ON v.business_profile_version_id=b.business_profile_version_id
            JOIN ${schema}.business_profiles p ON p.business_profile_id=v.business_profile_id
            LEFT JOIN ${schema}.connector_bindings x ON x.connector_binding_id=b.connector_binding_id
            WHERE p.customer_id=c.customer_id AND b.enabled=true
              AND (b.connector_binding_id IS NULL OR x.status='active')) AS enabled_capability_bindings,
         (SELECT count(*)::int FROM ${schema}.workflow_versions w
            WHERE w.customer_id=c.customer_id AND w.status='published') AS published_workflow_versions,
         (SELECT count(*)::int FROM ${schema}.escalation_policy_versions e
            WHERE e.customer_id=c.customer_id AND e.status='published') AS published_escalation_policies,
         (SELECT count(*)::int FROM ${schema}.agents a
            JOIN ${schema}.agent_release_manifests r ON r.agent_release_id=a.active_release_id
            LEFT JOIN ${schema}.agent_release_revocations x ON x.agent_release_id=r.agent_release_id
            WHERE a.customer_id=c.customer_id AND a.status='enabled' AND x.agent_release_id IS NULL) AS active_agent_releases,
         (SELECT count(*)::int FROM ${schema}.sessions s
            WHERE s.customer_id=c.customer_id AND s.runtime_api_version='v2' AND s.agent_release_id IS NOT NULL) AS pinned_v2_sessions,
         (SELECT count(*)::int FROM ${schema}.admin_audit_events a
            WHERE a.customer_id=c.customer_id) AS audit_events
       FROM ${schema}.customers c WHERE c.customer_id=$1`, [tenantId],
    ));
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Organisation not found.");

    const grants = new Set(permissions);
    const steps: ReadinessStep[] = [
      step(grants, ["organisation.read", "users.read", "permissions.read"], "organisation-access", "Organisation and access",
        row.organisation_status === "active" && count(row.active_members) > 0,
        `${count(row.active_members)} active member(s); ${count(row.pending_invitations)} pending invitation(s).`, ["ADM-01", "ADM-02", "ADM-10"]),
      step(grants, ["agents.read"], "foundational-profiles", "Foundational profiles",
        count(row.published_business_profiles) > 0 && count(row.published_provider_configurations) > 0 && count(row.published_experience_profiles) > 0,
        `${count(row.published_business_profiles)} business, ${count(row.published_provider_configurations)} provider and ${count(row.published_experience_profiles)} experience profile version(s) published.`, ["ADM-03"]),
      step(grants, ["instructions.read", "knowledge.read"], "approved-content", "Approved content",
        count(row.approved_instruction_revisions) > 0 && count(row.published_knowledge_revisions) > 0,
        `${count(row.approved_instruction_revisions)} approved instruction and ${count(row.published_knowledge_revisions)} published knowledge revision(s).`, ["ADM-05", "ADM-06"]),
      step(grants, ["tools.read", "connectors.read"], "tools-connectors", "Tools and connectors",
        count(row.active_connector_bindings) > 0 && count(row.enabled_capability_bindings) > 0,
        `${count(row.active_connector_bindings)} healthy connector and ${count(row.enabled_capability_bindings)} enabled capability binding(s).`, ["ADM-07", "ADM-08"]),
      step(grants, ["workflows.read", "escalations.read"], "operations-policy", "Workflow and escalation policy",
        count(row.published_workflow_versions) > 0 && count(row.published_escalation_policies) > 0,
        `${count(row.published_workflow_versions)} workflow and ${count(row.published_escalation_policies)} escalation policy version(s) published.`, ["ADM-09", "ADM-11"]),
      step(grants, ["agents.read", "agent_versions.read"], "active-release", "Active immutable release",
        count(row.active_agent_releases) > 0,
        `${count(row.active_agent_releases)} enabled agent(s) have a non-revoked active release.`, ["ADM-03", "ADM-04"]),
      runtimeStep(grants, row),
      step(grants, ["audit.read"], "audit-evidence", "Audit evidence",
        count(row.audit_events) > 0, `${count(row.audit_events)} tenant audit event(s) recorded.`, ["ADM-15"]),
    ];
    const hasFullVisibility = requiredReadPermissions.every((permission) => grants.has(permission));
    return {
      tenantId,
      generatedAt: new Date().toISOString(),
      scope: "existing-authorised-tenant",
      foundationalProfileAuthoring: "pre-provisioned-outside-current-admin-ui",
      activationReady: hasFullVisibility
        ? steps.filter(({ key }) => key !== "runtime-evidence").every(({ status }) => status === "ready")
        : null,
      completeVisibility: hasFullVisibility,
      steps,
      futureModules: [
        { moduleId: "ADM-12", status: "planned", taskId: "P6-A01" },
        { moduleId: "ADM-14", status: "planned", taskId: "P6-A03" },
        { moduleId: "ADM-16", status: "planned", taskId: "P6-A05" },
      ],
    };
  }
}

function step(
  grants: ReadonlySet<AdminPermission>, required: readonly AdminPermission[], key: string, label: string,
  ready: boolean, detail: string, moduleIds: string[],
): ReadinessStep {
  if (!required.every((permission) => grants.has(permission))) {
    return { key, label, status: "restricted", detail: "Your role cannot inspect every module in this step.", moduleIds };
  }
  return { key, label, status: ready ? "ready" : "not_configured", detail, moduleIds };
}

function runtimeStep(grants: ReadonlySet<AdminPermission>, row: ReadinessRow): ReadinessStep {
  if (!grants.has("agents.read")) {
    return { key: "runtime-evidence", label: "Pinned v2 session evidence", status: "restricted",
      detail: "Your role cannot inspect runtime release evidence.", moduleIds: ["ADM-03", "ADM-04"] };
  }
  const sessions = count(row.pinned_v2_sessions);
  return { key: "runtime-evidence", label: "Pinned v2 session evidence",
    status: sessions > 0 ? "ready" : "awaiting_runtime_evidence",
    detail: sessions > 0 ? `${sessions} v2 session(s) have an immutable release pin.` : "No v2 session has yet supplied runtime release evidence.",
    moduleIds: ["ADM-03", "ADM-04"] };
}

function count(value: number): number { return Number(value) || 0; }
