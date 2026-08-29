import { Module } from "@nestjs/common";
import { ConversationModule } from "./conversation/conversation.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { ProvidersModule } from "./providers/providers.module.js";
import { ToolsModule } from "./tools/tools.module.js";

@Module({
  imports: [
    DatabaseModule,
    ProvidersModule,
    ToolsModule,
    ConversationModule,
    HealthModule,
  ],
})
export class AppModule {}
