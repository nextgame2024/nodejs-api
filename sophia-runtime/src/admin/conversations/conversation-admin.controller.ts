import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { ConversationAdminService } from "./conversation-admin.service.js";

@Controller("admin/v1/tenants/:tenantId/conversations")
@UseGuards(AdminAuthGuard)
export class ConversationAdminController {
  constructor(private readonly conversations: ConversationAdminService) {}

  @Get() @RequireAdminPermissions("conversations.read_metadata")
  list(@Param("tenantId") tenantId: string, @Query() query: unknown) {
    return this.conversations.list(tenantId, query);
  }

  @Get("exports/jobs") @RequireAdminPermissions("conversations.export")
  exports(@Param("tenantId") tenantId: string) {
    return this.conversations.listExports(tenantId);
  }

  @Post(":sessionId/exports") @RequireAdminPermissions("conversations.export")
  createExport(@Param("tenantId") tenantId: string, @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.conversations.createExport(tenantId, sessionId, request.adminPrincipal.identityUserId,
      body, request.adminPrincipal.permissions.includes("conversations.read_content"));
  }

  @Get("exports/jobs/:exportId") @RequireAdminPermissions("conversations.export")
  downloadExport(@Param("tenantId") tenantId: string, @Param("exportId", new ParseUUIDPipe()) exportId: string,
    @Req() request: { adminPrincipal: AdminPrincipal }) {
    return this.conversations.downloadExport(tenantId, exportId, request.adminPrincipal.identityUserId,
      request.adminPrincipal.permissions.includes("conversations.read_content"));
  }

  @Get(":sessionId") @RequireAdminPermissions("conversations.read_metadata")
  detail(@Param("tenantId") tenantId: string, @Param("sessionId", new ParseUUIDPipe()) sessionId: string) {
    return this.conversations.detail(tenantId, sessionId);
  }

  @Get(":sessionId/content") @RequireAdminPermissions("conversations.read_content")
  content(@Param("tenantId") tenantId: string, @Param("sessionId", new ParseUUIDPipe()) sessionId: string) {
    return this.conversations.content(tenantId, sessionId);
  }

  @Post(":sessionId/notes") @RequireAdminPermissions("conversations.annotate")
  note(@Param("tenantId") tenantId: string, @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.conversations.addNote(tenantId, sessionId, request.adminPrincipal.identityUserId, body);
  }
}
