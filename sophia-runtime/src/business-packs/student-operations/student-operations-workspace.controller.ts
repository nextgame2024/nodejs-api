import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { STUDENT_OPERATIONS_PACK_CONTRACT } from "./student-operations.pack.js";
import {
  STUDENT_OPERATIONS_DATA_FLOWS,
  STUDENT_OPERATIONS_FIELD_POLICIES,
  STUDENT_OPERATIONS_POLICY_VERSION,
  STUDENT_OPERATIONS_RETENTION_TARGETS,
  STUDENT_OPERATIONS_ROLE_PERMISSIONS,
  STUDENT_OPERATIONS_STEP_UP_PERMISSIONS,
} from "./student-operations-policy.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";

@Controller("business-packs/student-operations/v1/tenants/:tenantId/workspace")
@UseGuards(StudentOperationsWorkspaceGuard)
export class StudentOperationsWorkspaceController {
  @Get()
  workspace(@Req() request: {
    studentOperationsPrincipal: StudentOperationsWorkspacePrincipal;
  }) {
    return {
      packId: STUDENT_OPERATIONS_PACK_CONTRACT.packId,
      version: STUDENT_OPERATIONS_PACK_CONTRACT.version,
      tenantId: request.studentOperationsPrincipal.tenantId,
      role: request.studentOperationsPrincipal.role,
      authorizationRevision:
        request.studentOperationsPrincipal.authorizationRevision,
      workspaceRoutes: STUDENT_OPERATIONS_PACK_CONTRACT.workspaceRoutes,
      readiness: {
        xero: "not-configured",
        documents: STUDENT_OPERATIONS_PACK_CONTRACT.documentStorage,
        assistant: STUDENT_OPERATIONS_PACK_CONTRACT.assistantTools,
        financialExecution:
          STUDENT_OPERATIONS_PACK_CONTRACT.financialExecution,
      },
    };
  }

  @Get("policy")
  policy() {
    return {
      version: STUDENT_OPERATIONS_POLICY_VERSION,
      roles: STUDENT_OPERATIONS_ROLE_PERMISSIONS,
      recentMfaRequiredFor: STUDENT_OPERATIONS_STEP_UP_PERMISSIONS,
      fieldPolicies: STUDENT_OPERATIONS_FIELD_POLICIES,
      dataFlows: STUDENT_OPERATIONS_DATA_FLOWS,
      retentionTargets: STUDENT_OPERATIONS_RETENTION_TARGETS,
    };
  }
}
