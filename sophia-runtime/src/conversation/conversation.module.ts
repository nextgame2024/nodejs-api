import { Module } from "@nestjs/common";
import { ProvidersModule } from "../providers/providers.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ConversationController } from "./conversation.controller.js";
import { ConversationService } from "./conversation.service.js";

@Module({
  imports: [ProvidersModule, ToolsModule],
  controllers: [ConversationController],
  providers: [ConversationService],
})
export class ConversationModule {}
