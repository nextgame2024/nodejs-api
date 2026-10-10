import { Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { XeroConnectorService } from "../../connectors/xero/xero-connector.service.js";
import { hasStudentOperationsPermission } from "./student-operations-policy.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";
import { StudentOperationsXeroSyncService } from "./student-operations-xero-sync.service.js";

type WorkspaceRequest = { studentOperationsPrincipal: StudentOperationsWorkspacePrincipal };

@Controller("business-packs/student-operations/v1/workspace/integrations/xero")
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentOperationsXeroController {
  constructor(
    private readonly xero: XeroConnectorService,
    private readonly sync: StudentOperationsXeroSyncService,
  ) {}

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
  studentCandidates(
    @Req() request: WorkspaceRequest,
    @Param("connectionId") connectionId: string,
    @Query() query: unknown,
  ) {
    const principal = this.authorize(request);
    return this.sync.candidates(principal.tenantId, connectionId, query);
  }

  @Get("connections/:connectionId/student-sync")
  studentSyncStatus(@Req() request: WorkspaceRequest, @Param("connectionId") connectionId: string) {
    const principal = this.authorize(request);
    return this.sync.status(principal.tenantId, connectionId);
  }

  @Post("connections/:connectionId/student-sync")
  @HttpCode(202)
  refreshStudents(@Req() request: WorkspaceRequest, @Param("connectionId") connectionId: string) {
    const principal = this.authorize(request);
    return this.sync.enqueueManual(principal, connectionId);
  }

  @Post("connections/:connectionId/student-role/trust")
  @HttpCode(200)
  configureTrust(@Req() request: WorkspaceRequest, @Param("connectionId") connectionId: string) {
    const principal = this.authorize(request);
    return this.sync.configureTrust(principal, connectionId);
  }

  private authorize(request: WorkspaceRequest): StudentOperationsWorkspacePrincipal {
    const principal = request.studentOperationsPrincipal;
    if (!hasStudentOperationsPermission(principal.role, "integrations.manage")) {
      throw new ForbiddenException("Chief Executive access is required to manage accounting connections.");
    }
    return principal;
  }
}
