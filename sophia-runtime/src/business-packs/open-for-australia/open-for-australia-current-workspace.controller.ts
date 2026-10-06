import { Controller, Get, Query, Req, SetMetadata, UseGuards } from "@nestjs/common";
import { OPEN_FOR_AUSTRALIA_PACK_CONTRACT } from "./open-for-australia.pack.js";
import { OpenForAustraliaStudentsService } from "./open-for-australia-students.service.js";
import { OpenForAustraliaWorkspaceGuard } from "./open-for-australia-workspace.guard.js";
import {
  OPEN_FOR_AUSTRALIA_DASHBOARD_CONTEXT,
  type OpenForAustraliaDashboardSummary,
  type OpenForAustraliaWorkspacePrincipal,
} from "./open-for-australia-workspace.service.js";

type WorkspaceRequest = {
  openForAustraliaPrincipal: OpenForAustraliaWorkspacePrincipal;
  openForAustraliaDashboardSummary?: OpenForAustraliaDashboardSummary;
};

@Controller("business-packs/open-for-australia/v1/workspace")
@UseGuards(OpenForAustraliaWorkspaceGuard)
export class OpenForAustraliaCurrentWorkspaceController {
  constructor(private readonly students: OpenForAustraliaStudentsService) {}

  @Get()
  workspace(@Req() request: WorkspaceRequest) {
    const principal = request.openForAustraliaPrincipal;
    return {
      packId: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.packId,
      version: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.version,
      tenantId: principal.tenantId,
      role: principal.role,
      authorizationRevision: principal.authorizationRevision,
      workspaceRoutes: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.workspaceRoutes,
    };
  }

  @Get("students")
  listStudents(@Req() request: WorkspaceRequest, @Query() query: unknown) {
    return this.students.list(request.openForAustraliaPrincipal, query);
  }

  @Get("dashboard")
  @SetMetadata(OPEN_FOR_AUSTRALIA_DASHBOARD_CONTEXT, true)
  async dashboard(@Req() request: WorkspaceRequest) {
    const summary = request.openForAustraliaDashboardSummary;
    if (!summary) throw new Error("Dashboard context was not resolved.");
    return {
      workspace: this.workspace(request),
      summary,
    };
  }
}
