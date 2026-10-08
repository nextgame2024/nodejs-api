import { Controller, Get, Query, Req, SetMetadata, UseGuards } from "@nestjs/common";
import { STUDENT_OPERATIONS_PACK_CONTRACT } from "./student-operations.pack.js";
import { StudentOperationsStudentsService } from "./student-operations-students.service.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import {
  STUDENT_OPERATIONS_DASHBOARD_CONTEXT,
  type StudentOperationsDashboardSummary,
  type StudentOperationsWorkspacePrincipal,
} from "./student-operations-workspace.service.js";

type WorkspaceRequest = {
  studentOperationsPrincipal: StudentOperationsWorkspacePrincipal;
  studentOperationsDashboardSummary?: StudentOperationsDashboardSummary;
};

@Controller("business-packs/student-operations/v1/workspace")
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentOperationsCurrentWorkspaceController {
  constructor(private readonly students: StudentOperationsStudentsService) {}

  @Get()
  workspace(@Req() request: WorkspaceRequest) {
    const principal = request.studentOperationsPrincipal;
    return {
      packId: STUDENT_OPERATIONS_PACK_CONTRACT.packId,
      version: STUDENT_OPERATIONS_PACK_CONTRACT.version,
      tenantId: principal.tenantId,
      role: principal.role,
      authorizationRevision: principal.authorizationRevision,
      workspaceRoutes: STUDENT_OPERATIONS_PACK_CONTRACT.workspaceRoutes,
    };
  }

  @Get("students")
  listStudents(@Req() request: WorkspaceRequest, @Query() query: unknown) {
    return this.students.list(request.studentOperationsPrincipal, query);
  }

  @Get("dashboard")
  @SetMetadata(STUDENT_OPERATIONS_DASHBOARD_CONTEXT, true)
  async dashboard(@Req() request: WorkspaceRequest) {
    const summary = request.studentOperationsDashboardSummary;
    if (!summary) throw new Error("Dashboard context was not resolved.");
    return {
      workspace: this.workspace(request),
      summary,
    };
  }
}
