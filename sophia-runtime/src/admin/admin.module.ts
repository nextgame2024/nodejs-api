import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AdminContextController } from "./admin-context.controller.js";
import { AdminAuditService } from "./authorization/admin-audit.service.js";
import { AdminAuthGuard } from "./authorization/admin-auth.guard.js";
import { AdminAuthorizationService } from "./authorization/admin-authorization.service.js";
import { BusinessManagerIdentityBridge } from "./identity/business-manager-identity.bridge.js";
import { AgentAuthoringController } from "./agents/agent-authoring.controller.js";
import { InstructionAuthoringController } from "./agents/instruction-authoring.controller.js";
import { AgentAuthoringService } from "./agents/agent-authoring.service.js";
import { AgentCollectionController } from "./agents/agent-collection.controller.js";
import {
  InvitationLifecycleController,
  InvitationRedemptionController,
  MembershipLifecycleController,
  OrganisationLifecycleController,
  PermissionRegistryController,
} from "./organisations/organisation-lifecycle.controller.js";
import { OrganisationLifecycleService } from "./organisations/organisation-lifecycle.service.js";
import { KnowledgeController } from "./knowledge/knowledge.controller.js";
import { KnowledgeService } from "./knowledge/knowledge.service.js";
import { PublishedKnowledgeCapabilityService } from "../capabilities-v2/services/published-knowledge-capability.service.js";
import { KnowledgeFileIntakeService } from "./knowledge/files/knowledge-file-intake.service.js";
import { PrivateS3KnowledgeStorageService } from "./knowledge/files/private-s3-knowledge-storage.service.js";
import { HttpMalwareScannerService } from "./knowledge/files/http-malware-scanner.service.js";
import { IsolatedTextParserService } from "./knowledge/files/isolated-text-parser.service.js";
import { KNOWLEDGE_MALWARE_SCANNER, KNOWLEDGE_OBJECT_STORAGE, KNOWLEDGE_TEXT_PARSER } from "./knowledge/files/knowledge-file.ports.js";
import { BusinessPacksModule } from "../business-packs/business-packs.module.js";
import { ToolConnectorAdminController } from "./tools-connectors/tool-connector-admin.controller.js";
import { ToolConnectorAdminService } from "./tools-connectors/tool-connector-admin.service.js";
import { WorkflowAdminController } from "./workflows/workflow-admin.controller.js";
import { WorkflowAdminService } from "./workflows/workflow-admin.service.js";
import { EscalationAdminController } from "./escalations/escalation-admin.controller.js";
import { EscalationAdminService } from "./escalations/escalation-admin.service.js";
import { AdminOnboardingReadinessController } from "./integration/admin-onboarding-readiness.controller.js";
import { AdminOnboardingReadinessService } from "./integration/admin-onboarding-readiness.service.js";
import { OperationalAccountabilityController } from "./operations/operational-accountability.controller.js";
import { OperationalAccountabilityService } from "./operations/operational-accountability.service.js";
import { ProviderUsageLedgerService } from "./operations/provider-usage-ledger.service.js";
import { EvaluationController } from "./evaluations/evaluation.controller.js";
import { EvaluationService } from "./evaluations/evaluation.service.js";
import { AuditExplorerController } from "./audit/audit-explorer.controller.js";
import { AuditExplorerService } from "./audit/audit-explorer.service.js";
import { AdminAuditInterceptor } from "./authorization/admin-audit.interceptor.js";
import { PrivacyController } from "./privacy/privacy.controller.js";
import { PrivacyService } from "./privacy/privacy.service.js";
import { PrivacyExecutionService } from "./privacy/privacy-execution.service.js";
import { ConversationAdminController } from "./conversations/conversation-admin.controller.js";
import { ConversationAdminService } from "./conversations/conversation-admin.service.js";
import { AnalyticsController } from "./analytics/analytics.controller.js";
import { AnalyticsService } from "./analytics/analytics.service.js";
import { UsageBillingController } from "./billing/usage-billing.controller.js";
import { UsageBillingService } from "./billing/usage-billing.service.js";
import { BILLING_PROVIDER } from "./billing/billing-provider.port.js";
import { DisabledBillingProvider } from "./billing/disabled-billing.provider.js";
import { UsageGuardrailService } from "./billing/usage-guardrail.service.js";
import { BillingLifecycleService } from "./billing/billing-lifecycle.service.js";
import { BillingWebhookController } from "./billing/billing-webhook.controller.js";
import { StripeSandboxBillingProvider } from "./billing/stripe-sandbox-billing.provider.js";
import { runtimeConfig } from "../config/runtime-config.js";

@Module({
  imports: [BusinessPacksModule],
  controllers: [
    AdminContextController, AgentCollectionController, AgentAuthoringController, InstructionAuthoringController,
    OrganisationLifecycleController, MembershipLifecycleController, InvitationLifecycleController,
    InvitationRedemptionController, PermissionRegistryController,
    KnowledgeController,
    ToolConnectorAdminController,
    WorkflowAdminController,
    EscalationAdminController,
    AdminOnboardingReadinessController,
    OperationalAccountabilityController,
    EvaluationController,
    AuditExplorerController,
    PrivacyController,
    ConversationAdminController,
    AnalyticsController,
    UsageBillingController,
    BillingWebhookController,
  ],
  providers: [
    BusinessManagerIdentityBridge,
    AdminAuthorizationService,
    AdminAuditService,
    AdminAuthGuard,
    AgentAuthoringService,
    OrganisationLifecycleService,
    KnowledgeService,
    PublishedKnowledgeCapabilityService,
    KnowledgeFileIntakeService,
    PrivateS3KnowledgeStorageService,
    HttpMalwareScannerService,
    IsolatedTextParserService,
    ToolConnectorAdminService,
    WorkflowAdminService,
    EscalationAdminService,
    AdminOnboardingReadinessService,
    OperationalAccountabilityService,
    ProviderUsageLedgerService,
    EvaluationService,
    AuditExplorerService,
    PrivacyService,
    PrivacyExecutionService,
    ConversationAdminService,
    AnalyticsService,
    UsageBillingService,
    UsageGuardrailService,
    BillingLifecycleService,
    DisabledBillingProvider,
    StripeSandboxBillingProvider,
    { provide: BILLING_PROVIDER, inject: [DisabledBillingProvider, StripeSandboxBillingProvider],
      useFactory: (disabled: DisabledBillingProvider, stripe: StripeSandboxBillingProvider) =>
        runtimeConfig().billing.provider === "stripe_sandbox" ? stripe : disabled },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
    { provide: KNOWLEDGE_OBJECT_STORAGE, useExisting: PrivateS3KnowledgeStorageService },
    { provide: KNOWLEDGE_MALWARE_SCANNER, useExisting: HttpMalwareScannerService },
    { provide: KNOWLEDGE_TEXT_PARSER, useExisting: IsolatedTextParserService },
  ],
  exports: [AdminAuthorizationService, AdminAuditService, AdminAuthGuard, KnowledgeFileIntakeService, ProviderUsageLedgerService],
})
export class AdminModule {}
