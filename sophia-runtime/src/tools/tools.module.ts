import { Module } from "@nestjs/common";
import { ToolRegistryService } from "./tools.service.js";
import { BusinessResearchService } from "./research/business-research.service.js";

@Module({
  providers: [BusinessResearchService, ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
