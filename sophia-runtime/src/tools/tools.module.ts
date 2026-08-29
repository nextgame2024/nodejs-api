import { Module } from "@nestjs/common";
import { ToolRegistryService } from "./tools.service.js";

@Module({
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
