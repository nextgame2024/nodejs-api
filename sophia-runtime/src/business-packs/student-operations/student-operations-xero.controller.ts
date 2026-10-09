import { Controller, ForbiddenException, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { XeroConnectorService } from "../../connectors/xero/xero-connector.service.js";
import { hasStudentOperationsPermission } from "./student-operations-policy.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";

type WorkspaceRequest = { studentOperationsPrincipal: StudentOperationsWorkspacePrincipal };

@Controller("business-packs/student-operations/v1/workspace/integrations/xero")
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentOperationsXeroController {
  constructor(private readonly xero: XeroConnectorService) {}

  @Get()
  status(@Req() request: WorkspaceRequest) {
    const principal = this.authorize(request);
    return this.xero.status(principal.tenantId);
  }

  @Post("authorization")
  @HttpCode(200)
  authorizeConnection(@Req() request: WorkspaceRequest) {
    const principal = this.authorize(request);
    return this.xero.beginAuthorization(principal.tenantId, principal.identityUserId);
  }

  @Post("connections/:connectionId/test")
  @HttpCode(200)
  testConnection(@Req() request: WorkspaceRequest, @Param("connectionId") connectionId: string) {
    const principal = this.authorize(request);
    return this.xero.testConnection(principal.tenantId, principal.identityUserId, connectionId);
  }

  @Get("connections/:connectionId/student-candidates")
  studentCandidates(@Req() request: WorkspaceRequest, @Param("connectionId") connectionId: string) {
    const principal = this.authorize(request);
    return this.xero.discoverStudentCandidates(principal.tenantId, connectionId);
  }

  private authorize(request: WorkspaceRequest): StudentOperationsWorkspacePrincipal {
    const principal = request.studentOperationsPrincipal;
    if (!hasStudentOperationsPermission(principal.role, "integrations.manage")) {
      throw new ForbiddenException("Chief Executive access is required to manage accounting connections.");
    }
    return principal;
  }
}
