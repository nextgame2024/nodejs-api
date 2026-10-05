import { Module } from "@nestjs/common";
import { AdminModule } from "../../admin/admin.module.js";
import { OpenForAustraliaWorkspaceController } from "./open-for-australia-workspace.controller.js";
import { OpenForAustraliaWorkspaceGuard } from "./open-for-australia-workspace.guard.js";
import { OpenForAustraliaWorkspaceService } from "./open-for-australia-workspace.service.js";

@Module({
  imports: [AdminModule],
  controllers: [OpenForAustraliaWorkspaceController],
  providers: [OpenForAustraliaWorkspaceService, OpenForAustraliaWorkspaceGuard],
  exports: [OpenForAustraliaWorkspaceService],
})
export class OpenForAustraliaModule {}
