import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { VerifiedBusinessManagerIdentity } from "../identity/business-manager-identity.bridge.js";
import {
  ADMIN_ROLE_PERMISSIONS,
  isAdminPermission,
  isAdminRoleKey,
  type AdminPermission,
} from "../permissions/admin-permissions.js";
import { ADMIN_API_VERSION, AdminPrincipalSchema, type AdminPrincipal } from "../contracts/admin-contracts.js";

type MembershipRow = {
  membership_id: string;
  customer_id: string;
  external_company_id: string;
  role_key: string;
  permission_overrides: { allow?: unknown; deny?: unknown } | null;
  authorization_revision: number;
};

@Injectable()
export class AdminAuthorizationService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async resolvePrincipal(identity: VerifiedBusinessManagerIdentity): Promise<AdminPrincipal> {
    const schema = runtimeConfig().schema;
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
              m.role_key, m.permission_overrides, m.authorization_revision
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
    const permissions = ADMIN_ROLE_PERMISSIONS[membership.role_key]
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
      ...(identity.mfaVerifiedAt ? { mfaVerifiedAt: identity.mfaVerifiedAt } : {}),
    });
  }

  hasPermission(principal: AdminPrincipal, permission: AdminPermission): boolean {
    return principal.permissions.includes(permission);
  }
}
