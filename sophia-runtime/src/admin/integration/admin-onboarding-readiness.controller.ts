import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { AdminOnboardingReadinessService } from "./admin-onboarding-readiness.service.js";

@Controller("admin/v1/tenants/:tenantId/onboarding-readiness")
@UseGuards(AdminAuthGuard)
export class AdminOnboardingReadinessController {
  constructor(private readonly readiness: AdminOnboardingReadinessService) {}

  @Get()
  @RequireAdminPermissions("organisation.read")
  inspect(
    @Param("tenantId") tenantId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
  ) {
    return this.readiness.inspect(tenantId, request.adminPrincipal.permissions);
  }
}
