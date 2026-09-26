import { Module } from "@nestjs/common";
import { ConversationModule } from "./conversation/conversation.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { ProvidersModule } from "./providers/providers.module.js";
import { ToolsModule } from "./tools/tools.module.js";
import { ConfigurationModule } from "./platform/configuration/configuration.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { ConnectorsModule } from "./connectors/connectors.module.js";
import { V2OrchestrationModule } from "./platform/orchestration/v2-orchestration.module.js";
import { RuntimeAdmissionModule } from "./platform/admission/runtime-admission.module.js";

@Module({
  imports: [
    DatabaseModule,
    RuntimeAdmissionModule,
    ProvidersModule,
    ToolsModule,
    ConfigurationModule,
    AdminModule,
    ConnectorsModule,
    ConversationModule,
    V2OrchestrationModule,
    HealthModule,
  ],
})
export class AppModule {}
