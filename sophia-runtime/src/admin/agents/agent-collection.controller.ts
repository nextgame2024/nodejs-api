import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { AgentAuthoringService } from "./agent-authoring.service.js";

@Controller("admin/v1/tenants/:tenantId/agents")
@UseGuards(AdminAuthGuard)
export class AgentCollectionController {
  constructor(private readonly agents: AgentAuthoringService) {}

  @Get()
  @RequireAdminPermissions("agents.read")
  list(@Param("tenantId") tenantId: string) {
    return this.agents.listAgents(tenantId);
  }

  @Get("authoring-dependencies")
  @RequireAdminPermissions("agents.read")
  dependencies(
    @Param("tenantId") tenantId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
  ) {
    return this.agents.listAuthoringDependencies(
      tenantId,
      request.adminPrincipal.permissions,
    );
  }

  @Post()
  @RequireAdminPermissions("agents.edit")
  create(
    @Param("tenantId") tenantId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.agents.createAgent(tenantId, request.adminPrincipal.identityUserId, body);
  }
}
