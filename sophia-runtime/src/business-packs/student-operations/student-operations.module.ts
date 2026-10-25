import { Module } from "@nestjs/common";
import { StudentDocumentTypesService } from './student-document-types.service.js';
import { StudentDocumentAnalysisService } from './student-document-analysis.service.js';
import { StudentOperationsCasesController } from './student-operations-cases.controller.js';
import { StudentOperationsCasesService } from './student-operations-cases.service.js';
import { StudentOperationsCaseDocumentsService } from './student-operations-case-documents.service.js';
import { AdminModule } from "../../admin/admin.module.js";
import { StudentOperationsWorkspaceController } from "./student-operations-workspace.controller.js";
import { StudentOperationsCurrentWorkspaceController } from "./student-operations-current-workspace.controller.js";
import { StudentOperationsWorkspaceGuard } from "./student-operations-workspace.guard.js";
import { StudentOperationsWorkspaceService } from "./student-operations-workspace.service.js";
import { StudentOperationsStudentsService } from "./student-operations-students.service.js";
import { StudentOperationsRegisterService } from "./student-operations-register.service.js";
import { ConnectorsModule } from "../../connectors/connectors.module.js";
import { StudentOperationsXeroController } from "./student-operations-xero.controller.js";
import { StudentOperationsXeroSyncService } from "./student-operations-xero-sync.service.js";
import { StudentOperationsXeroSyncScheduler } from "./student-operations-xero-sync.scheduler.js";
import { XeroWebhookController } from "../../connectors/xero/xero-webhook.controller.js";

@Module({
  imports: [AdminModule, ConnectorsModule],
  controllers: [
    StudentOperationsCasesController,
    StudentOperationsWorkspaceController,
    StudentOperationsCurrentWorkspaceController,
    StudentOperationsXeroController,
    XeroWebhookController,
  ],
  providers: [
    StudentDocumentAnalysisService,
    StudentDocumentTypesService,
    StudentOperationsCasesService,
    StudentOperationsCaseDocumentsService,
    StudentOperationsWorkspaceService,
    StudentOperationsWorkspaceGuard,
    StudentOperationsStudentsService,
    StudentOperationsRegisterService,
    StudentOperationsXeroSyncService,
    StudentOperationsXeroSyncScheduler,
  ],
  exports: [StudentOperationsWorkspaceService],
})
export class StudentOperationsModule {}
