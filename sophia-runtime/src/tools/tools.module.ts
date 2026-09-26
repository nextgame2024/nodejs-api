import { Module } from "@nestjs/common";
import { ToolRegistryService } from "./tools.service.js";
import { ProvidersModule } from "../providers/providers.module.js";
import { BusinessPacksModule } from "../business-packs/business-packs.module.js";

@Module({
  imports: [ProvidersModule, BusinessPacksModule],
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
