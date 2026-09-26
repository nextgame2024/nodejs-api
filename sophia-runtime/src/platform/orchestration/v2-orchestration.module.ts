import { Module } from "@nestjs/common";
import { ConversationModule } from "../../conversation/conversation.module.js";
import { ProvidersModule } from "../../providers/providers.module.js";
import { ToolsModule } from "../../tools/tools.module.js";
import { V2BootstrapService } from "./v2-bootstrap.service.js";
import { V2OrchestrationController } from "./v2-orchestration.controller.js";
import { V2ReadinessService } from "./v2-readiness.service.js";
import { V2SessionPlanResolver } from "./v2-session-plan.resolver.js";
import { V2SessionService } from "./v2-session.service.js";
import { ReasoningPipelineService } from "./reasoning-pipeline.service.js";
import { SecureReasoningToolExecutor } from "./reasoning-tool.executor.js";
import { OrchestratedVoicePipelineFactory } from "../media/orchestrated-voice-pipeline.js";
import { AdminModule } from "../../admin/admin.module.js";

@Module({
  imports: [ProvidersModule, ToolsModule, ConversationModule, AdminModule],
  controllers: [V2OrchestrationController],
  providers: [V2BootstrapService, V2SessionPlanResolver, V2SessionService, V2ReadinessService,
    SecureReasoningToolExecutor, ReasoningPipelineService, OrchestratedVoicePipelineFactory],
  exports: [ReasoningPipelineService, OrchestratedVoicePipelineFactory],
})
export class V2OrchestrationModule {}
