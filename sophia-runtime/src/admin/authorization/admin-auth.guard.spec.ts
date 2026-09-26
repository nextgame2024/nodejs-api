import { describe, expect, it, jest } from "@jest/globals";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { AdminAuthGuard } from "./admin-auth.guard.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";

const principal: AdminPrincipal = {
  apiVersion: "1.0.0",
  identityUserId: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalCompanyId: "33333333-3333-4333-8333-333333333333",
  membershipId: "22222222-2222-4222-8222-222222222222",
  role: "configuration_editor",
  permissions: ["organisation.read", "agents.edit"],
  authorizationRevision: 1,
};

function harness(options: {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  required?: string[];
  resolvedPrincipal?: AdminPrincipal;
}) {
  const request = { headers: options.headers ?? {}, params: options.params ?? {} };
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(options.required ?? []) };
  const identity = { authenticate: jest.fn().mockResolvedValue({
    userId: "user-1",
    companyId: principal.externalCompanyId,
    status: "active",
  }) };
  const authorization = {
    resolvePrincipal: jest.fn().mockResolvedValue(options.resolvedPrincipal ?? principal),
    hasPermission: jest.fn((value: AdminPrincipal, permission: string) => value.permissions.includes(permission as never)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const guard = new AdminAuthGuard(reflector as never, identity as never, authorization as never, audit as never);
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
  return { guard, context, request, identity, audit };
}

describe("AdminAuthGuard", () => {
  it("rejects requests without a bearer identity, including cookie-only requests", async () => {
    const { guard, context } = harness({ headers: { cookie: "token=public-runtime-token" } });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a direct cross-tenant API target and audits the denial", async () => {
    const { guard, context, audit } = harness({
      headers: { authorization: "Token business-manager-jwt" },
      params: { tenantId: "99999999-9999-4999-8999-999999999999" },
      required: ["organisation.read"],
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "denied",
      metadata: { reason: "cross_tenant_target" },
    }));
  });

  it("enforces permissions server-side", async () => {
    const { guard, context } = harness({
      headers: { authorization: "Bearer business-manager-jwt" },
      required: ["agents.publish"],
    });
    await expect(guard.canActivate(context)).rejects.toThrow("Missing Sophia Admin permission");
  });

  it("fails privileged operations closed without verified MFA evidence", async () => {
    const privileged = { ...principal, permissions: [...principal.permissions, "permissions.assign"] } as AdminPrincipal;
    const { guard, context } = harness({
      headers: { authorization: "Bearer business-manager-jwt" },
      required: ["permissions.assign"],
      resolvedPrincipal: privileged,
    });
    await expect(guard.canActivate(context)).rejects.toThrow("Recent MFA verification is required");
  });

  it("allows a tenant owner with recent MFA to use fixed-role assignment authority", async () => {
    const owner = {
      ...principal,
      role: "organisation_owner",
      permissions: [...principal.permissions, "users.manage", "users.roles.assign"],
      mfaVerifiedAt: new Date().toISOString(),
    } as AdminPrincipal;
    const { guard, context, request } = harness({
      headers: { authorization: "Bearer business-manager-jwt" },
      params: { tenantId: owner.tenantId },
      required: ["users.manage", "users.roles.assign"],
      resolvedPrincipal: owner,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request).toEqual(expect.objectContaining({ adminPrincipal: owner }));
  });

  it("does not let an operations member administer users in its own organisation", async () => {
    const operator = {
      ...principal,
      role: "operations_member",
      permissions: ["organisation.read", "users.read"],
      mfaVerifiedAt: new Date().toISOString(),
    } as AdminPrincipal;
    const { guard, context } = harness({
      headers: { authorization: "Bearer business-manager-jwt" },
      params: { tenantId: operator.tenantId },
      required: ["users.roles.assign"],
      resolvedPrincipal: operator,
    });

    await expect(guard.canActivate(context)).rejects.toThrow("Missing Sophia Admin permission");
  });

  it("attaches the tenant principal when authentication and policy pass", async () => {
    const { guard, context, request } = harness({
      headers: { authorization: "Bearer business-manager-jwt" },
      required: ["agents.edit"],
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request).toEqual(expect.objectContaining({ adminPrincipal: principal }));
  });
});
