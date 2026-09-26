import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AdminAuthorizationService } from "./admin-authorization.service.js";
import { AdminAuditService } from "./admin-audit.service.js";
import { ADMIN_PERMISSIONS_METADATA } from "./admin-permission.decorator.js";
import { BusinessManagerIdentityBridge } from "../identity/business-manager-identity.bridge.js";
import { MFA_REQUIRED_PERMISSIONS, type AdminPermission } from "../permissions/admin-permissions.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";

type AdminRequest = {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  adminPrincipal?: AdminPrincipal;
};

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(BusinessManagerIdentityBridge) private readonly identity: BusinessManagerIdentityBridge,
    @Inject(AdminAuthorizationService) private readonly authorization: AdminAuthorizationService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const authorizationHeader = header(request, "authorization");
    if (!authorizationHeader) {
      throw new UnauthorizedException("Sophia Admin authentication is required.");
    }
    const identity = await this.identity.authenticate(authorizationHeader);
    const principal = await this.authorization.resolvePrincipal(identity);
    const required = this.reflector.getAllAndOverride<AdminPermission[]>(
      ADMIN_PERMISSIONS_METADATA,
      [context.getHandler(), context.getClass()],
    ) ?? [];

    const targetTenant = request.params?.["tenantId"]
      ?? request.params?.["organisationId"]
      ?? request.params?.["customerId"];
    if (targetTenant && targetTenant !== principal.tenantId) {
      await this.denied(principal, required[0], "cross_tenant_target");
      throw new ForbiddenException("The requested organisation is outside this membership.");
    }
    for (const permission of required) {
      if (!this.authorization.hasPermission(principal, permission)) {
        await this.denied(principal, permission, "permission_missing");
        throw new ForbiddenException(`Missing Sophia Admin permission: ${permission}`);
      }
      if (MFA_REQUIRED_PERMISSIONS.has(permission) && !recentMfa(principal.mfaVerifiedAt)) {
        await this.denied(principal, permission, "mfa_required");
        throw new ForbiddenException("Recent MFA verification is required for this operation.");
      }
    }
    request.adminPrincipal = principal;
    return true;
  }

  private async denied(
    principal: AdminPrincipal,
    permission: AdminPermission | undefined,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      tenantId: principal.tenantId,
      identityUserId: principal.identityUserId,
      eventType: "admin.authorization.denied",
      permission,
      outcome: "denied",
      metadata: { reason },
    });
  }
}

function header(request: AdminRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function recentMfa(value: string | undefined): boolean {
  if (!value) return false;
  const verifiedAt = Date.parse(value);
  return Number.isFinite(verifiedAt) && verifiedAt >= Date.now() - 12 * 60 * 60 * 1000;
}
