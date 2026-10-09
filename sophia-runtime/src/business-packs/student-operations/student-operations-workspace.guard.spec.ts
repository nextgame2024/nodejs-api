import { describe, expect, it, jest } from "@jest/globals";
import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import { Reflector } from "@nestjs/core";

const principal = {
  identityUserId: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  externalCompanyId: "22222222-2222-4222-8222-222222222222",
  entitlementId: "33333333-3333-4333-8333-333333333333",
  role: "chief_executive" as const,
  authorizationRevision: 1,
};

function harness(input: {
  headers?: Record<string, string>;
  tenantId?: string;
} = {}) {
  const request = {
    headers: input.headers ?? {},
    params: { tenantId: input.tenantId ?? principal.tenantId },
  };
  const identity = { authenticate: jest.fn().mockResolvedValue({
    userId: "user-1",
    companyId: principal.externalCompanyId,
    status: "active",
  }) };
  const workspace = {
    resolvePrincipal: jest.fn().mockResolvedValue(principal),
    resolveDashboardPrincipal: jest.fn().mockResolvedValue({
      principal,
      summary: { totalStudents: 0, activeStudents: 0, newApplications: 0, actionRequired: 0, onHold: 0 },
    }),
    recordAccess: jest.fn().mockResolvedValue(undefined),
  };
  const guard = new StudentOperationsWorkspaceGuard(
    identity as never,
    workspace as never,
    new Reflector(),
  );
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function workspaceHandler() {},
  } as unknown as ExecutionContext;
  return { guard, context, request, identity, workspace };
}

describe("StudentOperationsWorkspaceGuard", () => {
  it("returns 401 semantics when no bearer identity is present", async () => {
    const { guard, context, identity } = harness();
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it("returns 403 semantics and audits a cross-tenant target", async () => {
    const { guard, context, workspace } = harness({
      headers: { authorization: "Bearer business-manager-token" },
      tenantId: "99999999-9999-4999-8999-999999999999",
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(workspace.recordAccess).toHaveBeenCalledWith(
      principal.tenantId,
      principal.identityUserId,
      "denied",
      expect.any(String),
      { reason: "cross_tenant_target" },
    );
  });

  it("attaches the principal whose resolution already recorded allowed access", async () => {
    const { guard, context, request, workspace } = harness({
      headers: {
        authorization: "Bearer business-manager-token",
        "x-correlation-id": "ofa-test-1",
      },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request).toEqual(expect.objectContaining({
      studentOperationsPrincipal: principal,
    }));
    expect(workspace.recordAccess).not.toHaveBeenCalled();
  });

  it("derives the current tenant when the route has no tenant parameter", async () => {
    const { guard, context, request } = harness({
      headers: { authorization: "Token business-manager-token" },
    });
    request.params = {};
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.studentOperationsPrincipal).toEqual(principal);
  });
});
