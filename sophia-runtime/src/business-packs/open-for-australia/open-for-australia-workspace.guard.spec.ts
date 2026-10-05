import { describe, expect, it, jest } from "@jest/globals";
import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { OpenForAustraliaWorkspaceGuard } from "./open-for-australia-workspace.guard.js";

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
    recordAccess: jest.fn().mockResolvedValue(undefined),
  };
  const guard = new OpenForAustraliaWorkspaceGuard(
    identity as never,
    workspace as never,
  );
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, context, request, identity, workspace };
}

describe("OpenForAustraliaWorkspaceGuard", () => {
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

  it("attaches the entitled principal and audits allowed access", async () => {
    const { guard, context, request, workspace } = harness({
      headers: {
        authorization: "Bearer business-manager-token",
        "x-correlation-id": "ofa-test-1",
      },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request).toEqual(expect.objectContaining({
      openForAustraliaPrincipal: principal,
    }));
    expect(workspace.recordAccess).toHaveBeenCalledWith(
      principal.tenantId,
      principal.identityUserId,
      "allowed",
      "ofa-test-1",
    );
  });
});
