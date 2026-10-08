import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { BusinessManagerIdentityBridge } from "../../admin/identity/business-manager-identity.bridge.js";
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
    const identity = await this.identity.authenticate(authorization);
    const isDashboard = this.reflector.get<boolean>(
      STUDENT_OPERATIONS_DASHBOARD_CONTEXT,
      context.getHandler(),
    ) === true;
    const dashboardContext = isDashboard
      ? await this.workspace.resolveDashboardPrincipal(identity, correlationId)
      : undefined;
    const principal = dashboardContext?.principal
      ?? await this.workspace.resolvePrincipal(identity, correlationId);
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
    if (dashboardContext) {
      request.studentOperationsDashboardSummary = dashboardContext.summary;
    }
    return true;
  }
}

function header(request: WorkspaceRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validCorrelation(value: string | undefined): string | undefined {
  return value && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : undefined;
}
