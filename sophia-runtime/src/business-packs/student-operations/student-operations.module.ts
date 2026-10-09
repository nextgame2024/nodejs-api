import { Module } from "@nestjs/common";
import { AdminModule } from "../../admin/admin.module.js";
import { StudentOperationsWorkspaceController } from "./student-operations-workspace.controller.js";
import { StudentOperationsCurrentWorkspaceController } from "./student-operations-current-workspace.controller.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import { StudentOperationsWorkspaceService } from "./student-operations-workspace.service.js";
import { StudentOperationsStudentsService } from "./student-operations-students.service.js";
import { ConnectorsModule } from "../../connectors/connectors.module.js";
import { StudentOperationsXeroController } from "./student-operations-xero.controller.js";

@Module({
  imports: [AdminModule, ConnectorsModule],
  controllers: [
    StudentOperationsWorkspaceController,
    StudentOperationsCurrentWorkspaceController,
    StudentOperationsXeroController,
  ],
  providers: [
    StudentOperationsWorkspaceService,
    StudentOperationsWorkspaceGuard,
    StudentOperationsStudentsService,
  ],
  exports: [StudentOperationsWorkspaceService],
})
export class StudentOperationsModule {}
