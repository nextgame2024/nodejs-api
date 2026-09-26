import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { ToolConnectorAdminService } from "./tool-connector-admin.service.js";

@Controller("admin/v1/tenants/:tenantId")
@UseGuards(AdminAuthGuard)
export class ToolConnectorAdminController {
  constructor(private readonly service: ToolConnectorAdminService) {}

  @Get("tool-registry")
  @RequireAdminPermissions("tools.read")
  registry() { return this.service.registry(); }

  @Get("capability-authoring-dependencies")
  @RequireAdminPermissions("tools.read")
  capabilityAuthoringDependencies(@Param("tenantId") tenantId: string) {
    return this.service.capabilityAuthoringDependencies(tenantId);
  }

  @Post("tool-registry/:operationId/sandbox")
  @RequireAdminPermissions("tools.test")
  sandbox(@Param("operationId") operationId: string) { return this.service.sandbox(operationId); }

  @Get("connector-registry")
  @RequireAdminPermissions("connectors.read")
  connectorRegistry() { return this.service.connectorRegistry(); }

  @Get("connectors")
  @RequireAdminPermissions("connectors.read")
  connectors(@Param("tenantId") tenantId: string) { return this.service.listConnectorBindings(tenantId); }

  @Post("connectors")
  @RequireAdminPermissions("connectors.manage")
  connect(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.connect(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("connectors/:bindingId/test")
  @RequireAdminPermissions("connectors.test")
  test(@Param("tenantId") tenantId: string, @Param("bindingId") bindingId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }) {
    return this.service.test(tenantId, bindingId, req.adminPrincipal.identityUserId);
  }

  @Post("connectors/:bindingId/reconnect")
  @RequireAdminPermissions("connectors.manage")
  reconnect(@Param("tenantId") tenantId: string, @Param("bindingId") bindingId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.reconnect(tenantId, bindingId, req.adminPrincipal.identityUserId, body);
  }

  @Post("connectors/:bindingId/disconnect")
  @RequireAdminPermissions("connectors.manage")
  disconnect(@Param("tenantId") tenantId: string, @Param("bindingId") bindingId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.disconnect(tenantId, bindingId, req.adminPrincipal.identityUserId, body);
  }

  @Get("business-profile-versions/:profileVersionId/capability-bindings")
  @RequireAdminPermissions("tools.read")
  capabilityBindings(@Param("tenantId") tenantId: string, @Param("profileVersionId") profileVersionId: string) {
    return this.service.listCapabilityBindings(tenantId, profileVersionId);
  }

  @Put("business-profile-versions/:profileVersionId/capability-bindings/:capabilityKey")
  @RequireAdminPermissions("tools.bind")
  putCapabilityBinding(@Param("tenantId") tenantId: string, @Param("profileVersionId") profileVersionId: string,
    @Param("capabilityKey") capabilityKey: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.putCapabilityBinding(tenantId, profileVersionId, capabilityKey, req.adminPrincipal.identityUserId, body);
  }
}
