import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { OPEN_FOR_AUSTRALIA_PACK_CONTRACT } from "./open-for-australia.pack.js";
import {
  OPEN_FOR_AUSTRALIA_DATA_FLOWS,
  OPEN_FOR_AUSTRALIA_FIELD_POLICIES,
  OPEN_FOR_AUSTRALIA_POLICY_VERSION,
  OPEN_FOR_AUSTRALIA_RETENTION_TARGETS,
  OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS,
  OPEN_FOR_AUSTRALIA_STEP_UP_PERMISSIONS,
} from "./open-for-australia-policy.js";
import { OpenForAustraliaWorkspaceGuard } from "./open-for-australia-workspace.guard.js";
import type { OpenForAustraliaWorkspacePrincipal } from "./open-for-australia-workspace.service.js";

@Controller("business-packs/open-for-australia/v1/tenants/:tenantId/workspace")
@UseGuards(OpenForAustraliaWorkspaceGuard)
export class OpenForAustraliaWorkspaceController {
  @Get()
  workspace(@Req() request: {
    openForAustraliaPrincipal: OpenForAustraliaWorkspacePrincipal;
  }) {
    return {
      packId: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.packId,
      version: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.version,
      tenantId: request.openForAustraliaPrincipal.tenantId,
      role: request.openForAustraliaPrincipal.role,
      authorizationRevision:
        request.openForAustraliaPrincipal.authorizationRevision,
      workspaceRoutes: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.workspaceRoutes,
      readiness: {
        xero: "not-configured",
        documents: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.documentStorage,
        assistant: OPEN_FOR_AUSTRALIA_PACK_CONTRACT.assistantTools,
        financialExecution:
          OPEN_FOR_AUSTRALIA_PACK_CONTRACT.financialExecution,
      },
    };
  }

  @Get("policy")
  policy() {
    return {
      version: OPEN_FOR_AUSTRALIA_POLICY_VERSION,
      roles: OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS,
      recentMfaRequiredFor: OPEN_FOR_AUSTRALIA_STEP_UP_PERMISSIONS,
      fieldPolicies: OPEN_FOR_AUSTRALIA_FIELD_POLICIES,
      dataFlows: OPEN_FOR_AUSTRALIA_DATA_FLOWS,
      retentionTargets: OPEN_FOR_AUSTRALIA_RETENTION_TARGETS,
    };
  }
}
