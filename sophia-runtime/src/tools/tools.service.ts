import { Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { getInventoryTool } from "./mock/get-inventory.tool.js";
import { BusinessResearchService } from "./research/business-research.service.js";
import { createResearchBusinessTool } from "./research/research-business.tool.js";
import { BusinessManagerClient } from "./real-estate/business-manager.client.js";
import { createRealEstateTools } from "./real-estate/real-estate.tools.js";
import {
  ToolRegistry,
} from "./tool-registry.js";
import type {
  RuntimeToolContext,
  RuntimeToolDefinition,
} from "./tool-registry.js";

@Injectable()
export class ToolRegistryService {
  private readonly registry = new ToolRegistry();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BusinessResearchService)
    private readonly businessResearch: BusinessResearchService,
    @Inject(BusinessManagerClient)
    private readonly businessManager: BusinessManagerClient,
  ) {
    this.registry.register(getInventoryTool);
    this.registry.register(createResearchBusinessTool(this.businessResearch));
    for (const tool of createRealEstateTools(this.businessManager)) this.registry.register(tool);
  }

  listDefinitions(): RuntimeToolDefinition[] {
    return this.registry.listDefinitions();
  }

  async execute(
    name: string,
    input: unknown,
    context: RuntimeToolContext,
  ): Promise<unknown> {
    const result = await this.registry.execute(name, input, context);

    if (context.sessionId) {
      await this.recordToolCall(name, input, result, context);
    }

    return result;
  }

  private async recordToolCall(
    name: string,
    input: unknown,
    output: unknown,
    context: RuntimeToolContext,
  ): Promise<void> {
    const config = runtimeConfig();
    await this.database.query(
      `
        INSERT INTO ${config.schema}.tool_calls (
          session_id,
          customer_id,
          tool_name,
          status,
          input,
          output,
          completed_at
        )
        VALUES ($1, $2, $3, 'succeeded', $4::jsonb, $5::jsonb, now())
      `,
      [
        context.sessionId,
        context.customerId,
        name,
        JSON.stringify(input ?? {}),
        JSON.stringify(output ?? {}),
      ],
    );
  }
}
