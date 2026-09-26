import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "./authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "./authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "./contracts/admin-contracts.js";

@Controller("admin/v1/context")
@UseGuards(AdminAuthGuard)
export class AdminContextController {
  @Get()
  @RequireAdminPermissions("organisation.read")
  context(@Req() request: { adminPrincipal: AdminPrincipal }) {
    return { principal: request.adminPrincipal };
  }
}
