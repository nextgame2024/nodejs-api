import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { WorkflowAdminService } from "./workflow-admin.service.js";

@Controller("admin/v1/tenants/:tenantId")
@UseGuards(AdminAuthGuard)
export class WorkflowAdminController {
  constructor(private readonly service: WorkflowAdminService) {}

  @Get("workflow-templates") @RequireAdminPermissions("workflows.read")
  templates() { return this.service.templates(); }

  @Get("workflows") @RequireAdminPermissions("workflows.read")
  list(@Param("tenantId") tenantId: string) { return this.service.list(tenantId); }

  @Post("workflows") @RequireAdminPermissions("workflows.configure")
  create(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.create(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("workflows/:definitionId/versions") @RequireAdminPermissions("workflows.configure")
  createVersion(@Param("tenantId") tenantId: string, @Param("definitionId") definitionId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.createVersion(tenantId, definitionId, req.adminPrincipal.identityUserId, body);
  }

  @Post("workflow-versions/:versionId/publish") @RequireAdminPermissions("workflows.publish")
  publish(@Param("tenantId") tenantId: string, @Param("versionId") versionId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }) {
    return this.service.publish(tenantId, versionId, req.adminPrincipal.identityUserId);
  }

  @Get("workflow-runs") @RequireAdminPermissions("workflows.read")
  runs(@Param("tenantId") tenantId: string) { return this.service.listRuns(tenantId); }

  @Post("workflow-runs") @RequireAdminPermissions("workflows.configure")
  pinRun(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.pinRun(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Get("workflow-runs/:runId/status") @RequireAdminPermissions("workflows.read")
  status(@Param("tenantId") tenantId: string, @Param("runId") runId: string) { return this.service.status(tenantId, runId); }

  @Post("workflow-runs/:runId/retry") @RequireAdminPermissions("workflows.retry")
  retry(@Param("tenantId") tenantId: string, @Param("runId") runId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.retry(tenantId, runId, req.adminPrincipal.identityUserId, body);
  }
}
