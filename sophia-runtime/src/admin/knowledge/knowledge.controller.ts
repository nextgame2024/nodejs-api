import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../authorization/admin-auth.guard.js";
import { RequireAdminPermissions } from "../authorization/admin-permission.decorator.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import { KnowledgeService } from "./knowledge.service.js";
import { KnowledgeFileIntakeService } from "./files/knowledge-file-intake.service.js";

@Controller("admin/v1/tenants/:tenantId/knowledge")
@UseGuards(AdminAuthGuard)
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly files: KnowledgeFileIntakeService,
  ) {}

  @Get("sources")
  @RequireAdminPermissions("knowledge.read")
  list(@Param("tenantId") tenantId: string) { return this.knowledge.list(tenantId); }

  @Get("bindings")
  @RequireAdminPermissions("knowledge.read")
  bindings(@Param("tenantId") tenantId: string) { return this.knowledge.listKnowledgeBindings(tenantId); }

  @Get("files/readiness")
  @RequireAdminPermissions("knowledge.read")
  fileReadiness() { return this.files.readiness(); }

  @Get("files")
  @RequireAdminPermissions("knowledge.read")
  fileIntakes(@Param("tenantId") tenantId: string) { return this.files.list(tenantId); }

  @Get("revisions/:revisionId")
  @RequireAdminPermissions("knowledge.read")
  revision(@Param("tenantId") tenantId: string, @Param("revisionId") revisionId: string) {
    return this.knowledge.getRevision(tenantId, revisionId);
  }

  @Post("sources")
  @RequireAdminPermissions("knowledge.edit")
  createSource(@Param("tenantId") tenantId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.knowledge.createSource(tenantId, request.adminPrincipal.identityUserId, body);
  }

  @Post("sources/:sourceId/revisions")
  @RequireAdminPermissions("knowledge.edit")
  createRevision(@Param("tenantId") tenantId: string, @Param("sourceId") sourceId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.knowledge.createRevision(tenantId, sourceId, request.adminPrincipal.identityUserId, body);
  }

  @Post("sources/:sourceId/files/initiate")
  @RequireAdminPermissions("knowledge.ingest")
  initiateFile(
    @Param("tenantId") tenantId: string,
    @Param("sourceId") sourceId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
    @Body() body: unknown,
  ) {
    return this.files.initiate(tenantId, sourceId, request.adminPrincipal.identityUserId, body);
  }

  @Post("files/:intakeId/complete")
  @RequireAdminPermissions("knowledge.ingest")
  completeFile(
    @Param("tenantId") tenantId: string,
    @Param("intakeId") intakeId: string,
    @Req() request: { adminPrincipal: AdminPrincipal },
  ) {
    return this.files.complete(tenantId, intakeId, request.adminPrincipal.identityUserId);
  }

  @Post("revisions/:revisionId/ingest")
  @RequireAdminPermissions("knowledge.ingest")
  ingest(@Param("tenantId") tenantId: string, @Param("revisionId") revisionId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.knowledge.ingest(tenantId, revisionId, request.adminPrincipal.identityUserId, body);
  }

  @Post("revisions/:revisionId/approve")
  @RequireAdminPermissions("knowledge.publish")
  approve(@Param("tenantId") tenantId: string, @Param("revisionId") revisionId: string, @Req() request: { adminPrincipal: AdminPrincipal }) {
    return this.knowledge.approve(tenantId, revisionId, request.adminPrincipal.identityUserId);
  }

  @Post("revisions/:revisionId/publish")
  @RequireAdminPermissions("knowledge.publish")
  publish(@Param("tenantId") tenantId: string, @Param("revisionId") revisionId: string, @Req() request: { adminPrincipal: AdminPrincipal }, @Body() body: unknown) {
    return this.knowledge.publish(tenantId, revisionId, request.adminPrincipal.identityUserId, body);
  }

  @Post("sources/:sourceId/retire")
  @RequireAdminPermissions("knowledge.retire")
  retire(@Param("tenantId") tenantId: string, @Param("sourceId") sourceId: string, @Req() request: { adminPrincipal: AdminPrincipal }) {
    return this.knowledge.retire(tenantId, sourceId, request.adminPrincipal.identityUserId);
  }

  @Post("preview")
  @RequireAdminPermissions("knowledge.read")
  preview(@Param("tenantId") tenantId: string, @Body() body: unknown) { return this.knowledge.preview(tenantId, body); }
}
