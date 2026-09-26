import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import type {
  OpenReasoningSessionRequest,
  ReasoningProvider,
  ReasoningProviderEvent,
  ReasoningProviderInput,
  ReasoningProviderSession,
  ReasoningToolDefinition,
} from "./reasoning-provider.interface.js";

type JsonObject = Record<string, unknown>;

@Injectable()
export class OpenAIResponsesReasoningProvider implements ReasoningProvider {
  async open(request: OpenReasoningSessionRequest): Promise<ReasoningProviderSession> {
    const config = runtimeConfig().openAi;
    if (!config.apiKey) throw new Error("OpenAI reasoning is unavailable because OPENAI_API_KEY is not configured.");
    return new OpenAIResponsesReasoningSession({
      apiKey: config.apiKey,
      model: config.reasoningModel,
      timeoutMs: config.reasoningTimeoutMs,
      maximumOutputTokens: config.reasoningMaximumOutputTokens,
      request,
    });
  }
}

class OpenAIResponsesReasoningSession implements ReasoningProviderSession {
  private continuationItems: unknown[] = [];
  private firstRequest = true;
  private readonly providerToolNames: Map<string, string>;
  private readonly canonicalToolNames: Map<string, string>;

  constructor(private readonly options: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    maximumOutputTokens: number;
    request: OpenReasoningSessionRequest;
  }) {
    const aliases = toolAliases(options.request.tools);
    this.providerToolNames = aliases.providerByCanonical;
    this.canonicalToolNames = aliases.canonicalByProvider;
  }

  async *stream(input: ReasoningProviderInput, signal: AbortSignal): AsyncGenerator<ReasoningProviderEvent> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      body: JSON.stringify({
        model: this.options.model,
        instructions: this.options.request.instructions,
        input: this.input(input),
        tools: this.options.request.tools.map((tool) => openAITool(tool, this.providerToolNames.get(tool.name)!)),
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: this.options.maximumOutputTokens,
        metadata: { sophia_session_id: this.options.request.sessionId },
      }),
    });
    if (!response.ok || !response.body) {
      yield {
        type: "response.failed",
        code: response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
        safeMessage: `OpenAI reasoning request failed with status ${response.status}.`,
        retryable: response.status === 429 || response.status >= 500,
      };
      return;
    }

    for await (const event of responseEvents(response.body)) {
      const type = stringValue(event["type"]);
      if (type === "response.output_text.delta") {
        const delta = stringValue(event["delta"]);
        if (delta) yield { type: "text.delta", delta };
      } else if (type === "response.output_item.done") {
        const item = objectValue(event["item"]);
        if (item?.["type"] === "function_call") {
          const callId = stringValue(item["call_id"]);
          const name = this.canonicalToolNames.get(stringValue(item["name"]));
          const parsed = parseArguments(item["arguments"]);
          if (!callId || !name || !parsed) {
            yield { type: "response.failed", code: "INVALID_PROVIDER_EVENT", safeMessage: "OpenAI returned an invalid tool call.", retryable: false };
            return;
          }
          yield { type: "tool.call", call: { callId, name, arguments: parsed } };
        }
      } else if (type === "response.completed") {
        const completed = objectValue(event["response"]);
        this.continuationItems = arrayValue(completed?.["output"]);
        const usage = usageValue(completed?.["usage"]);
        if (usage) yield { type: "usage", usage };
        yield { type: "response.completed" };
      } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
        yield {
          type: "response.failed",
          code: type === "response.incomplete" ? "INCOMPLETE_RESPONSE" : "PROVIDER_UNAVAILABLE",
          safeMessage: "OpenAI could not complete the reasoning response.",
          retryable: type !== "response.incomplete",
        };
        return;
      }
    }
  }

  async close(): Promise<void> {
    this.continuationItems = [];
  }

  private input(input: ReasoningProviderInput): unknown[] {
    if (input.type === "user") {
      if (!this.firstRequest) throw new Error("A reasoning provider session accepts one initial user turn.");
      this.firstRequest = false;
      return [
        ...this.options.request.history.map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content: input.text },
      ];
    }
    if (this.firstRequest || !this.continuationItems.length) {
      throw new Error("Tool outputs require a completed provider response.");
    }
    return [
      ...this.continuationItems,
      ...input.outputs.map((output) => ({
        type: "function_call_output",
        call_id: output.callId,
        output: JSON.stringify(output.output),
      })),
    ];
  }
}

function openAITool(tool: ReasoningToolDefinition, providerName: string): JsonObject {
  return { type: "function", name: providerName, description: tool.description,
    parameters: tool.inputSchema, strict: false };
}

function toolAliases(tools: readonly ReasoningToolDefinition[]): {
  providerByCanonical: Map<string, string>;
  canonicalByProvider: Map<string, string>;
} {
  const providerByCanonical = new Map<string, string>();
  const canonicalByProvider = new Map<string, string>();
  tools.forEach((tool, index) => {
    const semanticName = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
    const providerName = `sophia_${index}_${semanticName}`.slice(0, 64);
    providerByCanonical.set(tool.name, providerName);
    canonicalByProvider.set(providerName, tool.name);
  });
  return { providerByCanonical, canonicalByProvider };
}

async function* responseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<JsonObject> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = objectValue(JSON.parse(data));
        if (event) yield event;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseArguments(value: unknown): JsonObject | null {
  if (typeof value !== "string" || value.length > 100_000) return null;
  try { return objectValue(JSON.parse(value)); } catch { return null; }
}

function usageValue(value: unknown) {
  const usage = objectValue(value);
  if (!usage) return null;
  const inputDetails = objectValue(usage["input_tokens_details"]);
  const outputDetails = objectValue(usage["output_tokens_details"]);
  const inputTokens = numberValue(usage["input_tokens"]);
  const outputTokens = numberValue(usage["output_tokens"]);
  const totalTokens = numberValue(usage["total_tokens"]);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  const cachedInputTokens = numberValue(inputDetails?.["cached_tokens"]);
  const reasoningTokens = numberValue(outputDetails?.["reasoning_tokens"]);
  return { inputTokens, outputTokens, totalTokens,
    ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
    ...(reasoningTokens === null ? {} : { reasoningTokens }) };
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
