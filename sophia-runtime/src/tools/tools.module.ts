import { Module } from "@nestjs/common";
import { ToolRegistryService } from "./tools.service.js";
import { BusinessResearchService } from "./research/business-research.service.js";
import { BusinessManagerClient } from "./real-estate/business-manager.client.js";

@Module({
  providers: [BusinessResearchService, BusinessManagerClient, ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
