import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { PreviewAgentDraftSchema, PublishAgentDraftSchema } from "./agent-authoring.contracts.js";
import { AgentAuthoringService } from "./agent-authoring.service.js";

@Controller("admin/v1/tenants/:tenantId/agents/:agentId")
@UseGuards(AdminAuthGuard)
export class AgentAuthoringController {
  constructor(private readonly agents: AgentAuthoringService) {}

  @Get()
  @RequireAdminPermissions("agents.read")
  get(@Param("tenantId") tenantId: string, @Param("agentId") agentId: string) {
    return this.agents.getAgent(tenantId, agentId);
  }

  @Patch("draft")
  @RequireAdminPermissions("agents.edit")
  updateDraft(
    @Param("tenantId") tenantId: string,
    @Param("agentId") agentId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.agents.updateDraft(tenantId, agentId, request.adminPrincipal.identityUserId, body);
  }

  @Post("validate")
  @RequireAdminPermissions("agents.read")
  validate(@Param("tenantId") tenantId: string, @Param("agentId") agentId: string) {
    return this.agents.validateDraft(tenantId, agentId);
  }

  @Post("preview")
  @RequireAdminPermissions("agents.read", "instructions.test")
  preview(
    @Param("tenantId") tenantId: string,
    @Param("agentId") agentId: string,
    @Body() body: unknown,
  ) {
    return this.agents.previewDraft(
      tenantId,
      agentId,
      PreviewAgentDraftSchema.parse(body).variables,
    );
  }

  @Get("diff")
  @RequireAdminPermissions("agent_versions.read")
  diff(@Param("tenantId") tenantId: string, @Param("agentId") agentId: string) {
    return this.agents.diffDraft(tenantId, agentId);
  }

  @Get("releases")
  @RequireAdminPermissions("agent_versions.read")
  releases(@Param("tenantId") tenantId: string, @Param("agentId") agentId: string) {
    return this.agents.listReleases(tenantId, agentId);
  }

  @Post("publish")
  @RequireAdminPermissions("agents.publish", "agent_versions.publish")
  publish(
    @Param("tenantId") tenantId: string,
    @Param("agentId") agentId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    const parsed = PublishAgentDraftSchema.parse(body);
    return this.agents.publishDraft(
      tenantId, agentId, request.adminPrincipal.identityUserId,
      parsed.expectedRevision, parsed.releaseNotes,
    );
  }

  @Post("releases/:releaseId/rollback")
  @RequireAdminPermissions("agent_versions.rollback")
  rollback(
    @Param("tenantId") tenantId: string,
    @Param("agentId") agentId: string,
    @Param("releaseId") releaseId: string,
  ) {
    return this.agents.rollback(tenantId, agentId, releaseId);
  }

  @Post("releases/:releaseId/revoke")
  @RequireAdminPermissions("agents.disable")
  revoke(
    @Param("tenantId") tenantId: string,
    @Param("agentId") agentId: string,
    @Param("releaseId") releaseId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: { reason?: unknown },
  ) {
    return this.agents.revokeRelease(
      tenantId, agentId, releaseId, request.adminPrincipal.identityUserId,
      typeof body.reason === "string" ? body.reason : "",
    );
  }
}
