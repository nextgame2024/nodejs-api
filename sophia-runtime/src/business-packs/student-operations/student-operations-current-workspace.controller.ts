import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { STUDENT_OPERATIONS_PACK_CONTRACT } from "./student-operations.pack.js";
import { StudentOperationsStudentsService } from "./student-operations-students.service.js";
import { StudentOperationsRegisterService } from "./student-operations-register.service.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import { XeroConnectorService } from "../../connectors/xero/xero-connector.service.js";
import { StudentOperationsXeroSyncService } from "./student-operations-xero-sync.service.js";
import { hasStudentOperationsPermission } from "./student-operations-policy.js";
import { timeStudentOperations } from "./student-operations-timing.js";
import {
  STUDENT_OPERATIONS_DASHBOARD_CONTEXT,
  type StudentOperationsDashboardSummary,
  type StudentOperationsWorkspacePrincipal,
} from "./student-operations-workspace.service.js";

type WorkspaceRequest = {
  studentOperationsPrincipal: StudentOperationsWorkspacePrincipal;
  studentOperationsDashboardSummary?: StudentOperationsDashboardSummary;
  studentOperationsCorrelationId?: string;
};

@Controller("business-packs/student-operations/v1/workspace")
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentOperationsCurrentWorkspaceController {
  constructor(
    private readonly students: StudentOperationsStudentsService,
    private readonly register: StudentOperationsRegisterService,
    private readonly xero: XeroConnectorService,
    private readonly sync: StudentOperationsXeroSyncService,
  ) {}

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

  @Get("payments-register")
  async paymentsRegister(@Req() request: WorkspaceRequest, @Query() query: unknown) {
    const workspace = this.workspace(request);
    const principal = request.studentOperationsPrincipal;
    // Non-integration roles keep their existing, permission-scoped student view.
    // Never use client-selected roles, organisations or connection IDs here.
    if (!hasStudentOperationsPermission(principal.role, 'integrations.manage')) {
      return { workspace, connection: null, invoices: null, connectionIssue: null };
    }
    const status = await timeStudentOperations('xero-status', request.studentOperationsCorrelationId,
      () => this.xero.status(principal.tenantId));
    const active = status.connections.filter(connection => connection.status === 'active');
    const connection = active.find(connection => connection.organisationRole === 'trust')
      ?? (active.length === 1 ? active[0] : null);
    if (!connection) return { workspace, connection: null, invoices: null,
      connectionIssue: active.length > 1 ? 'ambiguous' : 'unavailable' };
    if (connection.missingStudentDiscoveryScopes.length) {
      return { workspace, connection, invoices: null, connectionIssue: 'scope_missing' };
    }
    const invoices = await this.sync.invoices(principal.tenantId, connection.connectionId, query,
      request.studentOperationsCorrelationId);
    return { workspace, connection, invoices, connectionIssue: null };
  }

  @Get("student-register")
  async studentRegister(@Req() request: WorkspaceRequest, @Query() query: unknown) {
    const result = await this.register.list(request.studentOperationsPrincipal, query,
      request.studentOperationsCorrelationId);
    return { ...result, workspace: this.workspace(request) };
  }

  @Get("advisors")
  advisors(@Req() request: WorkspaceRequest) {
    return this.students.advisors(request.studentOperationsPrincipal);
  }

  @Get("students/:studentId")
  student(@Req() request: WorkspaceRequest, @Param("studentId") studentId: string) {
    return this.students.get(request.studentOperationsPrincipal, studentId);
  }

  @Post("students")
  createStudent(
    @Req() request: WorkspaceRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.students.create(
      request.studentOperationsPrincipal,
      body,
      idempotencyKey,
      request.studentOperationsCorrelationId,
    );
  }

  @Patch("students/:studentId")
  updateStudent(
    @Req() request: WorkspaceRequest,
    @Param("studentId") studentId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.students.update(
      request.studentOperationsPrincipal,
      studentId,
      body,
      idempotencyKey,
      request.studentOperationsCorrelationId,
    );
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
