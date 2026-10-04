import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "./authorization/admin-auth.guard.js";
import { AdminAuthorizationService } from "./authorization/admin-authorization.service.js";
import { RequireAdminPermissions } from "./authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "./contracts/admin-contracts.js";

@Controller("admin/v1/context")
@UseGuards(AdminAuthGuard)
export class AdminContextController {
  constructor(
    @Inject(AdminAuthorizationService) private readonly authorization: AdminAuthorizationService,
  ) {}

  @Get()
  @RequireAdminPermissions("organisation.read")
  async context(@Req() request: { adminPrincipal: AdminPrincipal }) {
    return {
      principal: request.adminPrincipal,
      organisations: await this.authorization.listAvailableOrganisations(request.adminPrincipal),
    };
  }
}
