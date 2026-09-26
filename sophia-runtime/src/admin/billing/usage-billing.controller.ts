import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import { UsageBillingService } from "./usage-billing.service.js";
import { UsageGuardrailService } from "./usage-guardrail.service.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { BillingLifecycleService } from "./billing-lifecycle.service.js";

@Controller("admin/v1/tenants/:tenantId/usage-billing")
@UseGuards(AdminAuthGuard)
export class UsageBillingController {
  constructor(private readonly workspace: UsageBillingService, private readonly guardrails: UsageGuardrailService,
    private readonly lifecycle: BillingLifecycleService) {}

  @Get("usage") @RequireAdminPermissions("usage.read")
  usage(@Param("tenantId") tenantId: string) { return this.workspace.usage(tenantId); }

  @Get("commercial") @RequireAdminPermissions("billing.read")
  commercial(@Param("tenantId") tenantId: string) { return this.workspace.commercial(tenantId); }

  @Get("limits") @RequireAdminPermissions("usage.read")
  limits(@Param("tenantId") tenantId: string) { return this.guardrails.workspace(tenantId); }

  @Put("limits") @RequireAdminPermissions("usage.limits.manage")
  updateLimits(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.guardrails.update(tenantId, request.adminPrincipal, body);
  }

  @Post("checkout") @RequireAdminPermissions("billing.manage")
  checkout(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.lifecycle.checkout(tenantId, request.adminPrincipal, body);
  }

  @Post("portal") @RequireAdminPermissions("billing.manage")
  portal(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.lifecycle.portal(tenantId, request.adminPrincipal, body);
  }

  @Post("reconcile") @RequireAdminPermissions("billing.manage")
  reconcile(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.lifecycle.reconcile(tenantId, request.adminPrincipal, body);
  }
}
