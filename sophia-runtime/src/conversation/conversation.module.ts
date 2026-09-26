import { Module } from "@nestjs/common";
import { ProvidersModule } from "../providers/providers.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ConversationController } from "./conversation.controller.js";
import { ConversationService } from "./conversation.service.js";
import { ProviderOperationsService } from "../providers/session/provider-operations.service.js";
import { ProviderCatalogProvisioner } from "../providers/provisioning/provider-catalog-provisioner.js";

@Module({
  imports: [ProvidersModule, ToolsModule],
  controllers: [ConversationController],
  providers: [ConversationService, ProviderOperationsService, ProviderCatalogProvisioner],
  exports: [ProviderOperationsService, ProviderCatalogProvisioner],
})
export class ConversationModule {}
