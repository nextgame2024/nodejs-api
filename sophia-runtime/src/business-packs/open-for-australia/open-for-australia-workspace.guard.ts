import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { BusinessManagerIdentityBridge } from "../../admin/identity/business-manager-identity.bridge.js";
import {
  OpenForAustraliaWorkspaceService,
  type OpenForAustraliaWorkspacePrincipal,
} from "./open-for-australia-workspace.service.js";

type WorkspaceRequest = {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  openForAustraliaPrincipal?: OpenForAustraliaWorkspacePrincipal;
};

@Injectable()
export class OpenForAustraliaWorkspaceGuard implements CanActivate {
  constructor(
    @Inject(BusinessManagerIdentityBridge)
    private readonly identity: BusinessManagerIdentityBridge,
    @Inject(OpenForAustraliaWorkspaceService)
    private readonly workspace: OpenForAustraliaWorkspaceService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkspaceRequest>();
    const authorization = header(request, "authorization");
    if (!authorization) {
      throw new UnauthorizedException(
        "Open For Australia workspace authentication is required.",
      );
    }

    const correlationId = validCorrelation(header(request, "x-correlation-id"))
      ?? randomUUID();
    const identity = await this.identity.authenticate(authorization);
    const principal = await this.workspace.resolvePrincipal(identity, correlationId);
    const targetTenant = request.params?.["tenantId"];
    if (!targetTenant || targetTenant !== principal.tenantId) {
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

    await this.workspace.recordAccess(
      principal.tenantId,
      principal.identityUserId,
      "allowed",
      correlationId,
    );
    request.openForAustraliaPrincipal = principal;
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
