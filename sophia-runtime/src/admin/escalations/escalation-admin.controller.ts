import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { EscalationAdminService } from "./escalation-admin.service.js";

@Controller("admin/v1/tenants/:tenantId")
@UseGuards(AdminAuthGuard)
export class EscalationAdminController {
  constructor(private readonly service: EscalationAdminService) {}

  @Get("escalation-channels") @RequireAdminPermissions("escalations.read")
  channelRegistry() { return this.service.channelRegistry(); }

  @Get("escalation-destinations") @RequireAdminPermissions("escalations.read")
  destinations(@Param("tenantId") tenantId: string) { return this.service.listDestinations(tenantId); }

  @Post("escalation-destinations") @RequireAdminPermissions("escalations.configure")
  createDestination(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.createDestination(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Put("escalation-destinations/:destinationId") @RequireAdminPermissions("escalations.configure")
  updateDestination(@Param("tenantId") tenantId: string, @Param("destinationId") destinationId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.updateDestination(tenantId, destinationId, req.adminPrincipal.identityUserId, body);
  }

  @Get("escalation-policies") @RequireAdminPermissions("escalations.read")
  policies(@Param("tenantId") tenantId: string) { return this.service.listPolicies(tenantId); }

  @Post("escalation-policies") @RequireAdminPermissions("escalations.configure")
  createPolicy(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.createPolicy(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("escalation-policies/:policyId/versions") @RequireAdminPermissions("escalations.configure")
  createPolicyVersion(@Param("tenantId") tenantId: string, @Param("policyId") policyId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.createPolicyVersion(tenantId, policyId, req.adminPrincipal.identityUserId, body);
  }

  @Post("escalation-policy-versions/:versionId/publish") @RequireAdminPermissions("escalations.configure")
  publishPolicy(@Param("tenantId") tenantId: string, @Param("versionId") versionId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }) {
    return this.service.publishPolicy(tenantId, versionId, req.adminPrincipal.identityUserId);
  }

  @Get("escalation-cases") @RequireAdminPermissions("escalations.read")
  cases(@Param("tenantId") tenantId: string) { return this.service.listCases(tenantId); }

  @Get("escalation-cases/:caseId") @RequireAdminPermissions("escalations.read")
  case(@Param("tenantId") tenantId: string, @Param("caseId") caseId: string) {
    return this.service.getCase(tenantId, caseId);
  }

  @Post("escalation-cases") @RequireAdminPermissions("escalations.assign")
  createCase(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.createCase(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("escalation-cases/:caseId/assign") @RequireAdminPermissions("escalations.assign")
  assign(@Param("tenantId") tenantId: string, @Param("caseId") caseId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.assignCase(tenantId, caseId, req.adminPrincipal.identityUserId, body);
  }

  @Post("escalation-cases/:caseId/start") @RequireAdminPermissions("escalations.assign")
  start(@Param("tenantId") tenantId: string, @Param("caseId") caseId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.startCase(tenantId, caseId, req.adminPrincipal.identityUserId, body);
  }

  @Post("escalation-cases/:caseId/resolve") @RequireAdminPermissions("escalations.resolve")
  resolve(@Param("tenantId") tenantId: string, @Param("caseId") caseId: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.service.resolveCase(tenantId, caseId, req.adminPrincipal.identityUserId, body);
  }
}
