import { Module } from "@nestjs/common";
import { AdminModule } from "../../admin/admin.module.js";
import { StudentOperationsWorkspaceController } from "./student-operations-workspace.controller.js";
import { StudentOperationsCurrentWorkspaceController } from "./student-operations-current-workspace.controller.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import { StudentOperationsWorkspaceService } from "./student-operations-workspace.service.js";
import { StudentOperationsStudentsService } from "./student-operations-students.service.js";
import { ConnectorsModule } from "../../connectors/connectors.module.js";
import { StudentOperationsXeroController } from "./student-operations-xero.controller.js";
import { StudentOperationsXeroSyncService } from "./student-operations-xero-sync.service.js";
import { StudentOperationsXeroSyncScheduler } from "./student-operations-xero-sync.scheduler.js";
import { XeroWebhookController } from "../../connectors/xero/xero-webhook.controller.js";

@Module({
  imports: [AdminModule, ConnectorsModule],
  controllers: [
    StudentOperationsWorkspaceController,
    StudentOperationsCurrentWorkspaceController,
    StudentOperationsXeroController,
    XeroWebhookController,
  ],
  providers: [
    StudentOperationsWorkspaceService,
    StudentOperationsWorkspaceGuard,
    StudentOperationsStudentsService,
    StudentOperationsXeroSyncService,
    StudentOperationsXeroSyncScheduler,
  ],
  exports: [StudentOperationsWorkspaceService],
})
export class StudentOperationsModule {}
