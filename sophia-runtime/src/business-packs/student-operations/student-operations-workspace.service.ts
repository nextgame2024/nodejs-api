import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../database/database.service.js";
import type { VerifiedBusinessManagerIdentity } from "../../admin/identity/business-manager-identity.bridge.js";
import type { StudentOperationsRole } from "./student-operations-policy.js";

const PACK_ID = "student-operations";

type CustomerRow = {
  customer_id: string;
  external_company_id: string;
};

type EntitlementRow = {
  entitlement_id: string;
  customer_id: string;
  identity_user_id: string;
  role_key: StudentOperationsRole;
  authorization_revision: number;
};

export type StudentOperationsWorkspacePrincipal = {
  identityUserId: string;
  tenantId: string;
  externalCompanyId: string;
  entitlementId: string;
  role: StudentOperationsRole;
  authorizationRevision: number;
};

export type StudentOperationsDashboardSummary = {
  totalStudents: number;
  activeStudents: number;
  newApplications: number;
  actionRequired: number;
  onHold: number;
};

export const STUDENT_OPERATIONS_DASHBOARD_CONTEXT =
  "studentOperations.dashboardContext";

@Injectable()
export class StudentOperationsWorkspaceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async resolvePrincipal(
    identity: VerifiedBusinessManagerIdentity,
    correlationId: string = randomUUID(),
  ): Promise<StudentOperationsWorkspacePrincipal> {
    return (await this.resolve(identity, correlationId, false)).principal;
  }

  async resolveDashboardPrincipal(
    identity: VerifiedBusinessManagerIdentity,
    correlationId: string = randomUUID(),
  ): Promise<{
    principal: StudentOperationsWorkspacePrincipal;
    summary: StudentOperationsDashboardSummary;
  }> {
    const resolution = await this.resolve(identity, correlationId, true);
    if (!resolution.summary) throw new Error("Dashboard summary resolution failed closed.");
    return { principal: resolution.principal, summary: resolution.summary };
  }

  private async resolve(
    identity: VerifiedBusinessManagerIdentity,
    correlationId: string,
    includeDashboardSummary: boolean,
  ): Promise<{
    principal: StudentOperationsWorkspacePrincipal;
    summary?: StudentOperationsDashboardSummary;
  }> {
    const schema = runtimeSchema();
    const resolution = await this.database.transaction(async (client) => {
      const customer = await client.query<CustomerRow>(
        `SELECT customer_id, external_company_id
           FROM ${schema}.customers
          WHERE external_company_id = $1 AND status = 'active'
          LIMIT 2`,
        [identity.companyId],
      );
      if (customer.rows.length !== 1) return { kind: "customer_invalid" as const };

      const tenant = customer.rows[0];
      await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenant.customer_id]);
      const entitlement = await client.query<EntitlementRow>(
        `SELECT entitlement_id, customer_id, identity_user_id, role_key, authorization_revision
           FROM ${schema}.business_pack_entitlements
          WHERE customer_id = $1 AND identity_user_id = $2
            AND pack_id = $3 AND status = 'active'
          LIMIT 2`,
        [tenant.customer_id, identity.userId, PACK_ID],
      );
      if (entitlement.rows.length !== 1) {
        await this.insertAudit(client, schema, tenant.customer_id, identity.userId,
          "denied", correlationId, { reason: "entitlement_missing" });
        return { kind: "entitlement_missing" as const };
      }

      const row = entitlement.rows[0];
      await this.insertAudit(client, schema, tenant.customer_id, identity.userId,
        "allowed", correlationId, {});
      const summary = includeDashboardSummary
        ? await this.loadStudentSummary(client, schema, tenant.customer_id,
          row.role_key, row.identity_user_id)
        : undefined;
      return {
        kind: "resolved" as const,
        principal: {
          identityUserId: row.identity_user_id,
          tenantId: row.customer_id,
          externalCompanyId: tenant.external_company_id,
          entitlementId: row.entitlement_id,
          role: row.role_key,
          authorizationRevision: row.authorization_revision,
        },
        ...(summary ? { summary } : {}),
      };
    });

    if (resolution.kind === "customer_invalid") {
      throw new ForbiddenException(
        "An active, unambiguous Student Operations organisation is required.",
      );
    }
    if (resolution.kind === "entitlement_missing") {
      throw new ForbiddenException(
        "Student Operations workspace entitlement is required.",
      );
    }
    return { principal: resolution.principal, ...(resolution.summary
      ? { summary: resolution.summary }
      : {}) };
  }

  async recordAccess(
    tenantId: string,
    identityUserId: string,
    outcome: "allowed" | "denied" | "failed",
    correlationId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const schema = runtimeSchema();
    await this.database.tenantTransaction(tenantId, (client) => this.insertAudit(
      client,
      schema,
      tenantId,
      identityUserId,
      outcome,
      correlationId,
      metadata,
    ));
  }

  private async insertAudit(
    client: PoolClient,
    schema: string,
    tenantId: string,
    identityUserId: string,
    outcome: "allowed" | "denied" | "failed",
    correlationId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${schema}.business_pack_access_audit_events (
         customer_id, identity_user_id, pack_id, event_type,
         outcome, correlation_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        tenantId,
        identityUserId,
        PACK_ID,
        "business_pack.workspace.access",
        outcome,
        correlationId,
        JSON.stringify(metadata),
      ],
    );
  }

  private async loadStudentSummary(
    client: PoolClient,
    schema: string,
    tenantId: string,
    role: StudentOperationsRole,
    identityUserId: string,
  ): Promise<StudentOperationsDashboardSummary> {
    const params: unknown[] = [tenantId];
    const advisorScope = role === "advisor"
      ? " AND advisor_identity_user_id = $2"
      : "";
    if (role === "advisor") params.push(identityUserId);
    const result = await client.query<{
      total: number;
      active: number;
      new_applications: number;
      action_required: number;
      on_hold: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE current_stage = 'new_application')::int AS new_applications,
              count(*) FILTER (WHERE status = 'action_required')::int AS action_required,
              count(*) FILTER (WHERE status = 'on_hold')::int AS on_hold
         FROM ${schema}.student_operations_students
        WHERE customer_id = $1${advisorScope}`,
      params,
    );
    const summary = result.rows[0];
    return {
      totalStudents: Number(summary?.total ?? 0),
      activeStudents: Number(summary?.active ?? 0),
      newApplications: Number(summary?.new_applications ?? 0),
      actionRequired: Number(summary?.action_required ?? 0),
      onHold: Number(summary?.on_hold ?? 0),
    };
  }
}

function runtimeSchema(): string {
  const schema = process.env.SOPHIA_RUNTIME_SCHEMA || "sophia_runtime";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error("SOPHIA_RUNTIME_SCHEMA must be a valid PostgreSQL identifier.");
  }
  return schema;
}
