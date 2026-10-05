import { Module } from "@nestjs/common";
import { AdminModule } from "../../admin/admin.module.js";
import { OpenForAustraliaWorkspaceController } from "./open-for-australia-workspace.controller.js";
import { OpenForAustraliaCurrentWorkspaceController } from "./open-for-australia-current-workspace.controller.js";
import { OpenForAustraliaWorkspaceGuard } from "./open-for-australia-workspace.guard.js";
import { OpenForAustraliaWorkspaceService } from "./open-for-australia-workspace.service.js";
import { OpenForAustraliaStudentsService } from "./open-for-australia-students.service.js";

@Module({
  imports: [AdminModule],
  controllers: [OpenForAustraliaWorkspaceController, OpenForAustraliaCurrentWorkspaceController],
  providers: [
    OpenForAustraliaWorkspaceService,
    OpenForAustraliaWorkspaceGuard,
    OpenForAustraliaStudentsService,
  ],
  exports: [OpenForAustraliaWorkspaceService],
})
export class OpenForAustraliaModule {}
