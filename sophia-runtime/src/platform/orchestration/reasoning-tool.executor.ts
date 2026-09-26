import { Inject, Injectable } from "@nestjs/common";
import type { ToolResult } from "../contracts/v2/sophia-runtime-v2.contracts.js";
import type { ReasoningToolCall } from "../../providers/reasoning/reasoning-provider.interface.js";
import { ToolRegistryService } from "../../tools/tools.service.js";
import type { ReasoningExecutionContext, ReasoningToolExecutor } from "./reasoning-pipeline.js";

@Injectable()
export class SecureReasoningToolExecutor implements ReasoningToolExecutor {
  constructor(@Inject(ToolRegistryService) private readonly tools: ToolRegistryService) {}

  execute(call: ReasoningToolCall, context: ReasoningExecutionContext): Promise<ToolResult> {
    return this.tools.executeV2(call.name, call.arguments, {
      customerId: context.customerId,
      sessionId: context.sessionId,
      storeId: context.storeId,
      providerCallId: call.callId,
      eventSource: "provider_sideband",
      correlationId: context.correlationId,
      provenance: "server-provider-connection",
    }, context.sessionAccessToken);
  }
}
