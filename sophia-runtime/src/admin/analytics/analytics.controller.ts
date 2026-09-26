import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import { AnalyticsService } from "./analytics.service.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";

@Controller("admin/v1/tenants/:tenantId/analytics")
@UseGuards(AdminAuthGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @RequireAdminPermissions("analytics.read")
  dashboard(@Param("tenantId") tenantId: string, @Query() query: unknown) {
    return this.analytics.dashboard(tenantId, query);
  }

  @Get("exports/jobs")
  @RequireAdminPermissions("analytics.export")
  exports(@Param("tenantId") tenantId: string) { return this.analytics.listExports(tenantId); }

  @Post("exports")
  @RequireAdminPermissions("analytics.export")
  createExport(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown) {
    return this.analytics.createExport(tenantId, request.adminPrincipal.identityUserId, body);
  }

  @Get("exports/jobs/:exportId")
  @RequireAdminPermissions("analytics.export")
  downloadExport(@Param("tenantId") tenantId: string,
    @Param("exportId", new ParseUUIDPipe()) exportId: string,
    @Req() request: { adminPrincipal: AdminPrincipal }) {
    return this.analytics.downloadExport(tenantId, exportId, request.adminPrincipal.identityUserId);
  }
}
