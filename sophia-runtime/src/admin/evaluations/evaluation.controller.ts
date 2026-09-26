import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { EvaluationService } from "./evaluation.service.js";

@Controller("admin/v1/tenants/:tenantId/evaluations")
@UseGuards(AdminAuthGuard)
export class EvaluationController {
  constructor(private readonly evaluations: EvaluationService) {}

  @Get()
  @RequireAdminPermissions("evaluations.read")
  list(@Param("tenantId") tenantId: string) { return this.evaluations.list(tenantId); }

  @Get("registry")
  @RequireAdminPermissions("evaluations.read")
  registry() { return this.evaluations.registry(); }

  @Post("datasets")
  @RequireAdminPermissions("evaluations.edit")
  createDataset(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.evaluations.createDataset(tenantId, request.adminPrincipal.identityUserId, body);
  }

  @Post("datasets/:datasetId/versions")
  @RequireAdminPermissions("evaluations.edit")
  createVersion(@Param("tenantId") tenantId: string, @Param("datasetId") datasetId: string,
    @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.evaluations.createVersion(tenantId, datasetId, request.adminPrincipal.identityUserId, body);
  }

  @Post("versions/:versionId/approve")
  @RequireAdminPermissions("evaluations.approve")
  approve(@Param("tenantId") tenantId: string, @Param("versionId") versionId: string,
    @Req() request: { adminPrincipal: AdminPrincipal }) {
    return this.evaluations.approveVersion(tenantId, versionId, request.adminPrincipal.identityUserId);
  }

  @Post("requirements")
  @RequireAdminPermissions("evaluations.approve")
  bind(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.evaluations.bindRequirement(tenantId, request.adminPrincipal.identityUserId, body);
  }

  @Post("runs")
  @RequireAdminPermissions("evaluations.run")
  run(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.evaluations.run(tenantId, request.adminPrincipal.identityUserId, body);
  }
}
