import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { PrivacyService } from "./privacy.service.js";
import { PrivacyExecutionService } from "./privacy-execution.service.js";

@Controller("admin/v1/tenants/:tenantId/privacy")
@UseGuards(AdminAuthGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService, private readonly execution: PrivacyExecutionService) {}

  @Get()
  @RequireAdminPermissions("privacy.read")
  overview(@Param("tenantId") tenantId: string) { return this.privacy.overview(tenantId); }

  @Post("notices")
  @RequireAdminPermissions("privacy.manage")
  createNotice(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.createNotice(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("notices/:noticeId/approve")
  @RequireAdminPermissions("privacy.approve")
  approveNotice(@Param("tenantId") tenantId: string, @Param("noticeId") id: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.approveNotice(tenantId, id, req.adminPrincipal.identityUserId, body);
  }

  @Post("retention-policies")
  @RequireAdminPermissions("privacy.manage")
  createPolicy(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.createRetentionPolicy(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("retention-policies/:policyId/approve")
  @RequireAdminPermissions("privacy.approve")
  approvePolicy(@Param("tenantId") tenantId: string, @Param("policyId") id: string,
    @Req() req: { adminPrincipal: AdminPrincipal }) {
    return this.privacy.approveRetentionPolicy(tenantId, id, req.adminPrincipal.identityUserId);
  }

  @Put("data-flows")
  @RequireAdminPermissions("privacy.manage")
  upsertFlow(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.upsertDataFlow(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("data-flows/:flowId/approve")
  @RequireAdminPermissions("privacy.approve")
  approveFlow(@Param("tenantId") tenantId: string, @Param("flowId") id: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.approveDataFlow(tenantId, id, req.adminPrincipal.identityUserId, body);
  }

  @Put("legal-reviews/:controlKey")
  @RequireAdminPermissions("privacy.approve")
  updateLegalReview(@Param("tenantId") tenantId: string, @Param("controlKey") key: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.updateLegalReview(tenantId, key, req.adminPrincipal.identityUserId, body);
  }

  @Post("subject-requests")
  @RequireAdminPermissions("privacy.requests.manage")
  createRequest(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.createSubjectRequest(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("subject-requests/:requestId/verify")
  @RequireAdminPermissions("privacy.requests.manage")
  verifyRequest(@Param("tenantId") tenantId: string, @Param("requestId") id: string,
    @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.verifySubjectRequest(tenantId, id, req.adminPrincipal.identityUserId, body);
  }

  @Post("subject-requests/:requestId/execute")
  @RequireAdminPermissions("privacy.requests.manage")
  executeRequest(@Param("tenantId") tenantId: string, @Param("requestId") id: string,
    @Req() req: { adminPrincipal: AdminPrincipal }) {
    return this.execution.execute(tenantId, id, req.adminPrincipal.identityUserId);
  }

  @Post("subject-requests/:requestId/targets/:targetKey/evidence")
  @RequireAdminPermissions("privacy.requests.manage")
  recordTargetEvidence(@Param("tenantId") tenantId: string, @Param("requestId") id: string,
    @Param("targetKey") targetKey: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.execution.recordExternalEvidence(tenantId, id, targetKey, req.adminPrincipal.identityUserId, body);
  }

  @Post("retention-runs")
  @RequireAdminPermissions("privacy.approve")
  retentionRun(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.execution.retentionRun(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("legal-holds")
  @RequireAdminPermissions("privacy.holds.manage")
  createHold(@Param("tenantId") tenantId: string, @Req() req: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.privacy.createLegalHold(tenantId, req.adminPrincipal.identityUserId, body);
  }

  @Post("legal-holds/:holdId/release")
  @RequireAdminPermissions("privacy.holds.manage")
  releaseHold(@Param("tenantId") tenantId: string, @Param("holdId") id: string,
    @Req() req: { adminPrincipal: AdminPrincipal }) {
    return this.privacy.releaseLegalHold(tenantId, id, req.adminPrincipal.identityUserId);
  }
}
