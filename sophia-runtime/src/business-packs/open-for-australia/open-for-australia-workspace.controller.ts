import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { OPEN_FOR_AUSTRALIA_PACK_CONTRACT } from "./open-for-australia.pack.js";
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
}
