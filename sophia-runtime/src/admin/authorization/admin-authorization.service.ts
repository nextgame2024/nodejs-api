import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { VerifiedBusinessManagerIdentity } from "../identity/business-manager-identity.bridge.js";
import {
  isAdminPermission,
  isAdminRoleKey,
  permissionsForAdminRole,
  type AdminPermission,
} from "../permissions/admin-permissions.js";
import { ADMIN_API_VERSION, AdminPrincipalSchema, type AdminPrincipal } from "../contracts/admin-contracts.js";

type MembershipRow = {
  membership_id: string;
  customer_id: string;
  external_company_id: string;
  role_key: string;
  permission_overrides: { allow?: unknown; deny?: unknown } | null;
  module_scope: string[] | null;
  authorization_revision: number;
};

type PlatformAssignmentRow = {
  assignment_id: string;
  identity_user_id: string;
  operator_company_id: string;
  module_scope: string[];
  authorization_revision: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AdminOrganisationContext = {
  customerId: string;
  externalCompanyId: string;
  name: string;
  status: string;
};

@Injectable()
export class AdminAuthorizationService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async resolvePrincipal(
    identity: VerifiedBusinessManagerIdentity,
    requestedTenantId?: string,
  ): Promise<AdminPrincipal> {
    if (requestedTenantId && !UUID_PATTERN.test(requestedTenantId)) {
      throw new ForbiddenException("The selected Sophia organisation is unavailable.");
    }
    const schema = runtimeConfig().schema;
    const platform = await this.database.query<PlatformAssignmentRow>(
      `SELECT assignment_id, identity_user_id, operator_company_id,
              module_scope, authorization_revision
         FROM ${schema}.platform_operator_assignments
        WHERE identity_user_id = $1 AND operator_company_id = $2 AND status = 'active'
        LIMIT 2`,
      [identity.userId, identity.companyId],
    );
    if (platform.rows.length === 1) {
      return this.resolvePlatformPrincipal(identity, platform.rows[0], requestedTenantId);
    }
    if (requestedTenantId) {
      throw new ForbiddenException("Platform operator authority is required to select an organisation.");
    }

    const tenant = await this.database.query<{ customer_id: string; external_company_id: string }>(
      `SELECT customer_id, external_company_id FROM ${schema}.customers
       WHERE external_company_id = $1 LIMIT 2`,
      [identity.companyId],
    );
    if (tenant.rows.length !== 1) {
      throw new ForbiddenException("An unambiguous Sophia organisation is required.");
    }
    const result = await this.database.tenantTransaction(
      tenant.rows[0].customer_id,
      (client) => client.query<MembershipRow>(
      `SELECT m.membership_id, m.customer_id, c.external_company_id,
              m.role_key, m.permission_overrides, m.module_scope, m.authorization_revision
       FROM ${schema}.admin_memberships m
       JOIN ${schema}.customers c ON c.customer_id = m.customer_id
       WHERE m.identity_user_id = $1 AND m.status = 'active'
         AND c.external_company_id = $2
       LIMIT 2`,
      [identity.userId, identity.companyId],
      ),
    );
    if (result.rows.length !== 1) {
      throw new ForbiddenException("An active, unambiguous Sophia Admin membership is required.");
    }
    const membership = result.rows[0];
    if (!isAdminRoleKey(membership.role_key)) {
      throw new ForbiddenException("The Sophia Admin role is not recognised.");
    }
    const overrides = membership.permission_overrides ?? {};
    const allowedOverrides = Array.isArray(overrides.allow) ? overrides.allow : [];
    if (allowedOverrides.length) {
      throw new ForbiddenException("Permission elevation overrides are not enabled.");
    }
    const denied = new Set(
      (Array.isArray(overrides.deny) ? overrides.deny : [])
        .filter((value): value is string => typeof value === "string" && isAdminPermission(value)),
    );
    const permissions = permissionsForAdminRole(membership.role_key, membership.module_scope)
      .filter((permission) => !denied.has(permission));

    return AdminPrincipalSchema.parse({
      apiVersion: ADMIN_API_VERSION,
      identityUserId: identity.userId,
      tenantId: membership.customer_id,
      externalCompanyId: membership.external_company_id,
      membershipId: membership.membership_id,
      role: membership.role_key,
      permissions,
      authorizationRevision: membership.authorization_revision,
      authorityType: "tenant",
      ...(identity.mfaVerifiedAt ? { mfaVerifiedAt: identity.mfaVerifiedAt } : {}),
    });
  }

  async listAvailableOrganisations(principal: AdminPrincipal): Promise<AdminOrganisationContext[]> {
    const schema = runtimeConfig().schema;
    if (principal.authorityType !== "platform") {
      const tenant = await this.database.query<{
        customer_id: string; external_company_id: string; name: string; status: string;
      }>(
        `SELECT customer_id, external_company_id, name, status
           FROM ${schema}.customers WHERE customer_id = $1`,
        [principal.tenantId],
      );
      return tenant.rows.map(toOrganisationContext);
    }
    const tenants = await this.database.query<{
      customer_id: string; external_company_id: string; name: string; status: string;
    }>(
      `SELECT customer_id, external_company_id, name, status
         FROM ${schema}.customers
        ORDER BY lower(name), customer_id`,
    );
    return tenants.rows.map(toOrganisationContext);
  }

  hasPermission(principal: AdminPrincipal, permission: AdminPermission): boolean {
    return principal.permissions.includes(permission);
  }

  private async resolvePlatformPrincipal(
    identity: VerifiedBusinessManagerIdentity,
    assignment: PlatformAssignmentRow,
    requestedTenantId?: string,
  ): Promise<AdminPrincipal> {
    const schema = runtimeConfig().schema;
    const params: string[] = [];
    let where = "";
    if (requestedTenantId) {
      params.push(requestedTenantId);
      where = "WHERE customer_id = $1";
    }
    const tenant = await this.database.query<{
      customer_id: string; external_company_id: string;
    }>(
      `SELECT customer_id, external_company_id
         FROM ${schema}.customers
         ${where}
        ORDER BY lower(name), customer_id
        LIMIT 1`,
      params,
    );
    if (tenant.rows.length !== 1) {
      throw new ForbiddenException("The selected Sophia organisation is unavailable.");
    }
    const target = tenant.rows[0];
    return AdminPrincipalSchema.parse({
      apiVersion: ADMIN_API_VERSION,
      identityUserId: identity.userId,
      tenantId: target.customer_id,
      externalCompanyId: target.external_company_id,
      membershipId: assignment.assignment_id,
      role: "platform_operator",
      permissions: permissionsForAdminRole("platform_operator", assignment.module_scope),
      authorizationRevision: assignment.authorization_revision,
      authorityType: "platform",
      operatorCompanyId: assignment.operator_company_id,
      ...(identity.mfaVerifiedAt ? { mfaVerifiedAt: identity.mfaVerifiedAt } : {}),
    });
  }
}

function toOrganisationContext(row: {
  customer_id: string; external_company_id: string; name: string; status: string;
}): AdminOrganisationContext {
  return {
    customerId: row.customer_id,
    externalCompanyId: row.external_company_id,
    name: row.name,
    status: row.status,
  };
}
