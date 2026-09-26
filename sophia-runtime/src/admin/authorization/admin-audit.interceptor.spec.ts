import { describe, expect, it, jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";
import { AdminAuditInterceptor } from "./admin-audit.interceptor.js";

const principal = { tenantId: "11111111-1111-4111-8111-111111111111", identityUserId: "actor", permissions: ["agents.edit"] };

describe("AdminAuditInterceptor", () => {
  it("records allowed privileged requests without request bodies", async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(["agents.edit"]) };
    const interceptor = new AdminAuditInterceptor(reflector as never, audit as never);
    await expect(firstValueFrom(interceptor.intercept(context(), { handle: () => of({ ok: true }) } as never))).resolves.toEqual({ ok: true });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "admin.request.allowed", outcome: "allowed", resourceType: "agent", resourceId: "agent-1",
      metadata: expect.objectContaining({ method: "PATCH", requiredPermissions: ["agents.edit"] }),
    }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("request-body-secret");
  });

  it("records failed privileged requests and preserves the original error", async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const interceptor = new AdminAuditInterceptor({ getAllAndOverride: () => ["agents.edit"] } as never, audit as never);
    await expect(firstValueFrom(interceptor.intercept(context(), {
      handle: () => throwError(() => new BadRequestException("unsafe detail")),
    } as never))).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "admin.request.failed", outcome: "failed" }));
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("unsafe detail");
  });
});

function context() {
  const request = { method: "PATCH", route: { path: "/admin/v1/tenants/:tenantId/agents/:agentId/draft" },
    params: { tenantId: principal.tenantId, agentId: "agent-1" }, headers: {}, adminPrincipal: principal,
    body: { secret: "request-body-secret" } };
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => ({}), getClass: () => ({}) } as never;
}
