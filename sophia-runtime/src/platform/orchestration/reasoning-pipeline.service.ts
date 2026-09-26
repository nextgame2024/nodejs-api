import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ProviderUsageLedgerService } from "../../admin/operations/provider-usage-ledger.service.js";
import { ProviderCapabilityRegistry } from "../../providers/capability/provider-capability.registry.js";
import type { ReasoningProvider } from "../../providers/reasoning/reasoning-provider.interface.js";
import { ReasoningPipeline, type ReasoningPipelineEvent, type ReasoningPipelineRequest } from "./reasoning-pipeline.js";
import { SecureReasoningToolExecutor } from "./reasoning-tool.executor.js";

@Injectable()
export class ReasoningPipelineService {
  constructor(
    @Inject(ProviderCapabilityRegistry) private readonly providers: ProviderCapabilityRegistry,
    @Inject(SecureReasoningToolExecutor) private readonly tools: SecureReasoningToolExecutor,
    @Optional() @Inject(ProviderUsageLedgerService) private readonly usage?: ProviderUsageLedgerService,
  ) {}

  stream(adapterKey: string, request: ReasoningPipelineRequest): AsyncIterable<ReasoningPipelineEvent> {
    const registration = this.providers.resolve<ReasoningProvider>(adapterKey, "reasoning");
    const correlationId = request.correlationId ?? randomUUID();
    return this.instrument(registration.manifest.providerId, adapterKey,
      { ...request, correlationId }, new ReasoningPipeline(registration.implementation, this.tools).stream({ ...request, correlationId }));
  }

  private async *instrument(providerId: string, adapterKey: string, request: ReasoningPipelineRequest,
    stream: AsyncIterable<ReasoningPipelineEvent>): AsyncGenerator<ReasoningPipelineEvent> {
    let usageSequence = 0;
    let hasUsage = false;
    try {
      for await (const event of stream) {
        if (event.type === "usage" && this.usage) {
          usageSequence += 1;
          await this.usage.record({
            tenantId: request.customerId,
            sessionId: request.sessionId,
            sourceEventId: usageSource(request, adapterKey, `measured:${usageSequence}`),
            providerId,
            adapterKey,
            measurementStatus: "measured",
            usageDimensions: usageDimensions(event.usage),
          });
          hasUsage = true;
        }
        yield event;
      }
    } finally {
      if (!hasUsage && this.usage) {
        await this.usage.record({
          tenantId: request.customerId,
          sessionId: request.sessionId,
          sourceEventId: usageSource(request, adapterKey, "incomplete"),
          providerId,
          adapterKey,
          measurementStatus: "incomplete",
          usageDimensions: {},
        });
      }
    }
  }
}

function usageSource(request: ReasoningPipelineRequest, adapterKey: string, suffix: string): string {
  const identity = `${request.sessionId}:${request.correlationId}:${adapterKey}:${suffix}`;
  return `reasoning:${createHash("sha256").update(identity).digest("hex")}`;
}

function usageDimensions(usage: { inputTokens: number; outputTokens: number; totalTokens: number;
  cachedInputTokens?: number; reasoningTokens?: number }): Record<string, number> {
  return {
    "input-tokens": usage.inputTokens,
    "output-tokens": usage.outputTokens,
    "total-tokens": usage.totalTokens,
    ...(usage.cachedInputTokens === undefined ? {} : { "cached-input-tokens": usage.cachedInputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { "reasoning-tokens": usage.reasoningTokens }),
  };
}
