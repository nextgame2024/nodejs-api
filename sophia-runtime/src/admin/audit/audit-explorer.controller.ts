import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { AuditExplorerService } from "./audit-explorer.service.js";

@Controller("admin/v1/tenants/:tenantId/audit")
@UseGuards(AdminAuthGuard)
export class AuditExplorerController {
  constructor(private readonly explorer: AuditExplorerService) {}

  @Get("events") @RequireAdminPermissions("audit.read")
  list(@Param("tenantId") tenantId: string, @Query() query: unknown) { return this.explorer.list(tenantId, query); }

  @Get("events/:eventId") @RequireAdminPermissions("audit.read")
  detail(@Param("tenantId") tenantId: string, @Param("eventId", new ParseUUIDPipe()) eventId: string) { return this.explorer.detail(tenantId, eventId); }

  @Get("retention") @RequireAdminPermissions("audit.read")
  retention() { return this.explorer.retentionStatus(); }

  @Get("exports") @RequireAdminPermissions("audit.export")
  exports(@Param("tenantId") tenantId: string) { return this.explorer.listExports(tenantId); }

  @Post("exports") @RequireAdminPermissions("audit.export")
  createExport(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.explorer.createExport(tenantId, request.adminPrincipal.identityUserId, body);
  }

  @Get("exports/:exportId") @RequireAdminPermissions("audit.export")
  download(@Param("tenantId") tenantId: string, @Param("exportId", new ParseUUIDPipe()) exportId: string,
    @Req() request: { adminPrincipal: AdminPrincipal }) {
    return this.explorer.downloadExport(tenantId, exportId, request.adminPrincipal.identityUserId);
  }
}
