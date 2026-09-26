import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import { OperationalAccountabilityService } from "./operational-accountability.service.js";

@Controller("admin/v1/tenants/:tenantId/operations")
@UseGuards(AdminAuthGuard)
export class OperationalAccountabilityController {
  constructor(private readonly operations: OperationalAccountabilityService) {}

  @Get("status")
  @RequireAdminPermissions("analytics.read")
  status(@Param("tenantId") tenantId: string) { return this.operations.status(tenantId); }

  @Get("usage")
  @RequireAdminPermissions("usage.read")
  usage(@Param("tenantId") tenantId: string) { return this.operations.usage(tenantId); }
}
