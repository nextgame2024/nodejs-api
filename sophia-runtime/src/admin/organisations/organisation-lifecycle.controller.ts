import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { BusinessManagerIdentityBridge } from "../identity/business-manager-identity.bridge.js";
import { OrganisationLifecycleService } from "./organisation-lifecycle.service.js";

@Controller("admin/v1/tenants/:tenantId/organisation")
@UseGuards(AdminAuthGuard)
export class OrganisationLifecycleController {
  constructor(private readonly lifecycle: OrganisationLifecycleService) {}

  @Get()
  @RequireAdminPermissions("organisation.read")
  get(@Param("tenantId") tenantId: string) {
    return this.lifecycle.getOrganisation(tenantId);
  }

  @Patch()
  @RequireAdminPermissions("organisation.manage")
  update(
    @Param("tenantId") tenantId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.lifecycle.updateOrganisation(tenantId, request.adminPrincipal, body);
  }

  @Post("suspend")
  @RequireAdminPermissions("organisation.suspend")
  suspend(
    @Param("tenantId") tenantId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.lifecycle.suspendOrganisation(tenantId, request.adminPrincipal, body);
  }

  @Post("resume")
  @RequireAdminPermissions("organisation.suspend")
  resume(
    @Param("tenantId") tenantId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.lifecycle.resumeOrganisation(tenantId, request.adminPrincipal, body);
  }
}

@Controller("admin/v1/tenants/:tenantId/members")
@UseGuards(AdminAuthGuard)
export class MembershipLifecycleController {
  constructor(private readonly lifecycle: OrganisationLifecycleService) {}

  @Get()
  @RequireAdminPermissions("users.read")
  list(@Param("tenantId") tenantId: string) {
    return this.lifecycle.listMembers(tenantId);
  }

  @Patch(":membershipId")
  @RequireAdminPermissions("users.manage", "users.roles.assign")
  update(
    @Param("tenantId") tenantId: string,
    @Param("membershipId") membershipId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.lifecycle.updateMembership(tenantId, membershipId, request.adminPrincipal, body);
  }
}

@Controller("admin/v1/tenants/:tenantId/invitations")
@UseGuards(AdminAuthGuard)
export class InvitationLifecycleController {
  constructor(private readonly lifecycle: OrganisationLifecycleService) {}

  @Get()
  @RequireAdminPermissions("users.read")
  list(@Param("tenantId") tenantId: string) {
    return this.lifecycle.listInvitations(tenantId);
  }

  @Post()
  @RequireAdminPermissions("users.invite", "users.roles.assign")
  issue(
    @Param("tenantId") tenantId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.lifecycle.issueInvitation(tenantId, request.adminPrincipal, body);
  }

  @Post(":invitationId/revoke")
  @RequireAdminPermissions("users.invite")
  revoke(
    @Param("tenantId") tenantId: string,
    @Param("invitationId") invitationId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.lifecycle.revokeInvitation(tenantId, invitationId, request.adminPrincipal, body);
  }
}

@Controller("admin/v1/invitations")
export class InvitationRedemptionController {
  constructor(
    private readonly lifecycle: OrganisationLifecycleService,
    private readonly identity: BusinessManagerIdentityBridge,
  ) {}

  @Post("redeem")
  async redeem(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const identity = await this.identity.authenticate(authorization ?? "");
    return this.lifecycle.redeemInvitation(identity, body);
  }
}

@Controller("admin/v1/tenants/:tenantId/permissions")
@UseGuards(AdminAuthGuard)
export class PermissionRegistryController {
  constructor(private readonly lifecycle: OrganisationLifecycleService) {}

  @Get()
  @RequireAdminPermissions("permissions.read")
  list() {
    return this.lifecycle.permissionRegistry();
  }
}
