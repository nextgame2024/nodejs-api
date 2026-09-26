import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { ADMIN_PERMISSIONS, ADMIN_ROLE_PERMISSIONS, type AdminPermission } from "../permissions/admin-permissions.js";
import { AdminOnboardingReadinessService } from "./admin-onboarding-readiness.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

describe("AdminOnboardingReadinessService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("reports an integrated persisted journey without treating runtime evidence as publication authority", async () => {
    const { service, query, transaction } = setup(row());
    const result = await service.inspect(tenantId, ADMIN_PERMISSIONS as unknown as AdminPermission[]);

    expect(result.activationReady).toBe(true);
    expect(result.scope).toBe("existing-authorised-tenant");
    expect(result.foundationalProfileAuthoring).toBe("pre-provisioned-outside-current-admin-ui");
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "foundational-profiles", status: "ready" }),
      expect.objectContaining({ key: "active-release", status: "ready" }),
      expect.objectContaining({ key: "runtime-evidence", status: "awaiting_runtime_evidence" }),
      expect.objectContaining({ key: "audit-evidence", status: "ready" }),
    ]));
    expect(result.futureModules).toEqual(expect.arrayContaining([
      { moduleId: "ADM-12", status: "planned", taskId: "P6-A01" },
      { moduleId: "ADM-16", status: "planned", taskId: "P6-A05" },
    ]));
    expect(transaction).toHaveBeenCalledWith(tenantId, expect.any(Function));
    expect(String(query.mock.calls[0]?.[0])).toContain("WHERE c.customer_id=$1");
    expect(query.mock.calls[0]?.[1]).toEqual([tenantId]);
  });

  it("masks module readiness when the caller lacks its read permission", async () => {
    const { service } = setup(row());
    const result = await service.inspect(tenantId, ["organisation.read"]);

    expect(result.activationReady).toBeNull();
    expect(result.completeVisibility).toBe(false);
    expect(result.steps.find(({ key }) => key === "organisation-access")?.status).toBe("restricted");
    expect(result.steps.find(({ key }) => key === "approved-content")?.detail).not.toContain("1 approved");
    expect(result.steps.find(({ key }) => key === "audit-evidence")?.status).toBe("restricted");
  });

  it("gives the fixed organisation owner complete readiness visibility without edit authority", async () => {
    const { service } = setup(row());
    const result = await service.inspect(tenantId, ADMIN_ROLE_PERMISSIONS.organisation_owner);

    expect(result.completeVisibility).toBe(true);
    expect(result.activationReady).toBe(true);
    expect(ADMIN_ROLE_PERMISSIONS.organisation_owner).toContain("escalations.read");
    expect(ADMIN_ROLE_PERMISSIONS.organisation_owner).not.toContain("escalations.configure");
    expect(ADMIN_ROLE_PERMISSIONS.organisation_owner).toContain("audit.export");
    expect(ADMIN_ROLE_PERMISSIONS.read_only_auditor).not.toContain("audit.export");
    expect(ADMIN_ROLE_PERMISSIONS.configuration_editor).toContain("escalations.configure");
  });

  it("keeps incomplete foundations and missing module configuration explicit", async () => {
    const { service } = setup(row({
      published_provider_configurations: 0,
      active_connector_bindings: 0,
      enabled_capability_bindings: 0,
      published_workflow_versions: 0,
      published_escalation_policies: 0,
      active_agent_releases: 0,
    }));
    const result = await service.inspect(tenantId, ADMIN_PERMISSIONS as unknown as AdminPermission[]);

    expect(result.activationReady).toBe(false);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "foundational-profiles", status: "not_configured" }),
      expect.objectContaining({ key: "tools-connectors", status: "not_configured" }),
      expect.objectContaining({ key: "operations-policy", status: "not_configured" }),
      expect.objectContaining({ key: "active-release", status: "not_configured" }),
    ]));
  });

  it("fails closed for an unknown tenant", async () => {
    const { service } = setup(undefined);
    await expect(service.inspect(tenantId, ["organisation.read"]))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

function setup(value: ReturnType<typeof row> | undefined) {
  const query = jest.fn().mockResolvedValue({ rows: value ? [value] : [], rowCount: value ? 1 : 0 });
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_tenantId: string, work: (client: PoolClient) => unknown) => work(client));
  return {
    service: new AdminOnboardingReadinessService({ tenantTransaction: transaction } as never),
    query,
    transaction,
  };
}

function row(changes: Record<string, unknown> = {}) {
  return {
    organisation_status: "active",
    active_members: 2,
    pending_invitations: 1,
    published_business_profiles: 1,
    published_provider_configurations: 1,
    published_experience_profiles: 1,
    approved_instruction_revisions: 1,
    published_knowledge_revisions: 1,
    active_connector_bindings: 1,
    enabled_capability_bindings: 4,
    published_workflow_versions: 1,
    published_escalation_policies: 1,
    active_agent_releases: 1,
    pinned_v2_sessions: 0,
    audit_events: 10,
    ...changes,
  };
}
