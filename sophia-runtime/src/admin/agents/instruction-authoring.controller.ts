import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { AgentAuthoringService } from "./agent-authoring.service.js";

@Controller("admin/v1/tenants/:tenantId/instructions")
@UseGuards(AdminAuthGuard)
export class InstructionAuthoringController {
  constructor(private readonly agents: AgentAuthoringService) {}

  @Get()
  @RequireAdminPermissions("instructions.read")
  list(@Param("tenantId") tenantId: string) {
    return this.agents.listInstructionSets(tenantId);
  }

  @Post()
  @RequireAdminPermissions("instructions.edit")
  createSet(@Param("tenantId") tenantId: string, @Body() body: unknown) {
    return this.agents.createInstructionSet(tenantId, body);
  }

  @Post(":instructionSetId/revisions")
  @RequireAdminPermissions("instructions.edit")
  createRevision(
    @Param("tenantId") tenantId: string,
    @Param("instructionSetId") instructionSetId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.agents.createInstructionRevision(
      tenantId, instructionSetId, request.adminPrincipal.identityUserId, body,
    );
  }

  @Post("revisions/:revisionId/approve")
  @RequireAdminPermissions("instructions.edit")
  approve(@Param("tenantId") tenantId: string, @Param("revisionId") revisionId: string) {
    return this.agents.approveInstructionRevision(tenantId, revisionId);
  }
}
