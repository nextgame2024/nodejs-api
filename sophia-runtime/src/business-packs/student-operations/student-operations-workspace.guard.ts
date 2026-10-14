import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Reflector } from "@nestjs/core";
import { BusinessManagerIdentityBridge } from "../../admin/identity/business-manager-identity.bridge.js";
import { elapsedMs, logStudentOperationsTiming, studentOperationsTimingEnabled } from "./student-operations-timing.js";
import {
  StudentOperationsWorkspaceService,
  STUDENT_OPERATIONS_DASHBOARD_CONTEXT,
  type StudentOperationsDashboardSummary,
  type StudentOperationsWorkspacePrincipal,
} from "./student-operations-workspace.service.js";

type WorkspaceRequest = {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  studentOperationsPrincipal?: StudentOperationsWorkspacePrincipal;
  studentOperationsDashboardSummary?: StudentOperationsDashboardSummary;
  studentOperationsCorrelationId?: string;
};

@Injectable()
export class StudentOperationsWorkspaceGuard implements CanActivate {
  constructor(
    @Inject(BusinessManagerIdentityBridge)
    private readonly identity: BusinessManagerIdentityBridge,
    @Inject(StudentOperationsWorkspaceService)
    private readonly workspace: StudentOperationsWorkspaceService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkspaceRequest>();
    const authorization = header(request, "authorization");
    if (!authorization) {
      throw new UnauthorizedException(
        "Student Operations workspace authentication is required.",
      );
    }

    const correlationId = validCorrelation(header(request, "x-correlation-id"))
      ?? randomUUID();
    if (studentOperationsTimingEnabled()) {
      context.switchToHttp().getResponse?.<{ setHeader?: (name: string, value: string) => void }>()
        ?.setHeader?.("X-Correlation-ID", correlationId);
    }
    const startedAt = performance.now();
    let identityMs: number | undefined;
    let entitlementMs: number | undefined;
    let outcome: "ok" | "error" = "error";
    try {
      const identityStartedAt = performance.now();
      const identity = await this.identity.authenticate(authorization);
      identityMs = elapsedMs(identityStartedAt);
      const entitlementStartedAt = performance.now();
      const isDashboard = this.reflector.get<boolean>(
        STUDENT_OPERATIONS_DASHBOARD_CONTEXT,
        context.getHandler(),
      ) === true;
      const dashboardContext = isDashboard
        ? await this.workspace.resolveDashboardPrincipal(identity, correlationId)
        : undefined;
      const principal = dashboardContext?.principal
        ?? await this.workspace.resolvePrincipal(identity, correlationId);
      entitlementMs = elapsedMs(entitlementStartedAt);
      const targetTenant = request.params?.["tenantId"];
      if (targetTenant && targetTenant !== principal.tenantId) {
        await this.workspace.recordAccess(
          principal.tenantId,
          principal.identityUserId,
          "denied",
          correlationId,
          { reason: "cross_tenant_target" },
        );
        throw new ForbiddenException(
          "The requested organisation is outside this workspace entitlement.",
        );
      }

      request.studentOperationsPrincipal = principal;
      request.studentOperationsCorrelationId = correlationId;
      if (dashboardContext) {
        request.studentOperationsDashboardSummary = dashboardContext.summary;
      }
      outcome = "ok";
      return true;
    } finally {
      logStudentOperationsTiming("workspace-guard", correlationId, outcome, {
        identityMs, entitlementMs, totalMs: elapsedMs(startedAt),
      }, context.getHandler().name);
    }
  }
}

function header(request: WorkspaceRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validCorrelation(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : undefined;
}
