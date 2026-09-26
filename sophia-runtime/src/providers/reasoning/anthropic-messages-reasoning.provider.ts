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
export class AnthropicMessagesReasoningProvider implements ReasoningProvider {
  async open(request: OpenReasoningSessionRequest): Promise<ReasoningProviderSession> {
    const config = runtimeConfig().anthropic;
    if (!config.apiKey) throw new Error("Claude reasoning is unavailable because ANTHROPIC_API_KEY is not configured.");
    return new AnthropicMessagesReasoningSession({
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maximumOutputTokens: config.maximumOutputTokens,
      request,
    });
  }
}

class AnthropicMessagesReasoningSession implements ReasoningProviderSession {
  private messages: JsonObject[];
  private firstRequest = true;
  private readonly providerToolNames: Map<string, string>;
  private readonly canonicalToolNames: Map<string, string>;

  constructor(private readonly options: {
    apiKey: string;
    apiBaseUrl: string;
    model: string;
    timeoutMs: number;
    maximumOutputTokens: number;
    request: OpenReasoningSessionRequest;
  }) {
    this.messages = options.request.history.map((message) => ({ role: message.role, content: message.content }));
    const aliases = toolAliases(options.request.tools);
    this.providerToolNames = aliases.providerByCanonical;
    this.canonicalToolNames = aliases.canonicalByProvider;
  }

  async *stream(input: ReasoningProviderInput, signal: AbortSignal): AsyncGenerator<ReasoningProviderEvent> {
    this.appendInput(input);
    const response = await fetch(`${this.options.apiBaseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maximumOutputTokens,
        system: this.options.request.instructions,
        messages: this.messages,
        tools: this.options.request.tools.map((tool) => anthropicTool(tool, this.providerToolNames.get(tool.name)!)),
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      yield httpFailure(response.status);
      return;
    }

    const blocks = new Map<number, JsonObject>();
    const toolInput = new Map<number, string>();
    let inputUsage: JsonObject | null = null;
    let outputTokens: number | null = null;
    let stopReason = "";
    let toolCalls = 0;

    for await (const event of responseEvents(response.body)) {
      const type = stringValue(event["type"]);
      if (type === "message_start") {
        inputUsage = objectValue(objectValue(event["message"])?.["usage"]);
      } else if (type === "content_block_start") {
        const index = integerValue(event["index"]);
        const block = objectValue(event["content_block"]);
        if (index !== null && block) blocks.set(index, { ...block });
      } else if (type === "content_block_delta") {
        const index = integerValue(event["index"]);
        const delta = objectValue(event["delta"]);
        const block = index === null ? null : blocks.get(index);
        if (index === null || !delta || !block) continue;
        const deltaType = stringValue(delta["type"]);
        if (deltaType === "text_delta") {
          const text = stringValue(delta["text"]);
          if (text) {
            block["text"] = `${stringValue(block["text"])}${text}`;
            yield { type: "text.delta", delta: text };
          }
        } else if (deltaType === "input_json_delta") {
          toolInput.set(index, `${toolInput.get(index) ?? ""}${stringValue(delta["partial_json"])}`);
        } else if (deltaType === "thinking_delta") {
          block["thinking"] = `${stringValue(block["thinking"])}${stringValue(delta["thinking"])}`;
        } else if (deltaType === "signature_delta") {
          block["signature"] = `${stringValue(block["signature"])}${stringValue(delta["signature"])}`;
        }
      } else if (type === "content_block_stop") {
        const index = integerValue(event["index"]);
        const block = index === null ? null : blocks.get(index);
        if (index === null || block?.["type"] !== "tool_use") continue;
        const callId = stringValue(block["id"]);
        const name = this.canonicalToolNames.get(stringValue(block["name"]));
        const parsed = parseArguments(toolInput.get(index) ?? JSON.stringify(block["input"] ?? {}));
        if (!callId || !name || !parsed) {
          yield providerFailure("INVALID_PROVIDER_EVENT", "Claude returned an invalid tool call.", false);
          return;
        }
        block["input"] = parsed;
        toolCalls += 1;
        yield { type: "tool.call", call: { callId, name, arguments: parsed } };
      } else if (type === "message_delta") {
        stopReason = stringValue(objectValue(event["delta"])?.["stop_reason"]);
        outputTokens = numberValue(objectValue(event["usage"])?.["output_tokens"]);
      } else if (type === "error") {
        const errorType = stringValue(objectValue(event["error"])?.["type"]);
        yield anthropicStreamFailure(errorType);
        return;
      } else if (type === "message_stop") {
        const usage = usageValue(inputUsage, outputTokens);
        if (!usage || !validStop(stopReason, toolCalls)) {
          yield providerFailure("INVALID_PROVIDER_EVENT", "Claude returned an incomplete reasoning response.", false);
          return;
        }
        if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
          yield providerFailure("INCOMPLETE_RESPONSE", "Claude reached a configured response limit.", false);
          return;
        }
        if (stopReason === "refusal") {
          yield providerFailure("PROVIDER_REFUSAL", "Claude declined the reasoning request.", false);
          return;
        }
        this.messages.push({ role: "assistant", content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) });
        yield { type: "usage", usage };
        yield { type: "response.completed" };
        return;
      }
    }
  }

  async close(): Promise<void> {
    this.messages = [];
  }

  private appendInput(input: ReasoningProviderInput): void {
    if (input.type === "user") {
      if (!this.firstRequest) throw new Error("A reasoning provider session accepts one initial user turn.");
      this.firstRequest = false;
      this.messages.push({ role: "user", content: input.text });
      return;
    }
    if (this.firstRequest || this.messages.at(-1)?.["role"] !== "assistant") {
      throw new Error("Tool outputs require a completed provider response.");
    }
    this.messages.push({
      role: "user",
      content: input.outputs.map((output) => ({
        type: "tool_result",
        tool_use_id: output.callId,
        content: JSON.stringify(output.output),
        ...(toolResultIsError(output.output) ? { is_error: true } : {}),
      })),
    });
  }
}

function anthropicTool(tool: ReasoningToolDefinition, providerName: string): JsonObject {
  return { name: providerName, description: tool.description, input_schema: tool.inputSchema, strict: true };
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

function usageValue(input: JsonObject | null, outputTokens: number | null) {
  if (!input || outputTokens === null) return null;
  const uncached = numberValue(input["input_tokens"]);
  const cacheCreation = numberValue(input["cache_creation_input_tokens"]) ?? 0;
  const cacheRead = numberValue(input["cache_read_input_tokens"]) ?? 0;
  if (uncached === null) return null;
  const inputTokens = uncached + cacheCreation + cacheRead;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    ...(cacheRead ? { cachedInputTokens: cacheRead } : {}) };
}

function validStop(stopReason: string, toolCalls: number): boolean {
  if (stopReason === "tool_use") return toolCalls > 0;
  return toolCalls === 0 && ["end_turn", "stop_sequence", "max_tokens", "refusal", "model_context_window_exceeded"].includes(stopReason);
}

function toolResultIsError(value: unknown): boolean {
  const status = stringValue(objectValue(value)?.["status"]);
  return ["failed", "denied", "cancelled", "outcome_unknown"].includes(status);
}

function httpFailure(status: number): ReasoningProviderEvent {
  const retryable = status === 429 || status === 500 || status === 504 || status === 529;
  const code = status === 429 ? "RATE_LIMITED"
    : status === 401 || status === 403 ? "PROVIDER_AUTHENTICATION_FAILED"
      : status >= 400 && status < 500 ? "INVALID_PROVIDER_REQUEST" : "PROVIDER_UNAVAILABLE";
  return providerFailure(code, `Claude reasoning request failed with status ${status}.`, retryable);
}

function anthropicStreamFailure(errorType: string): ReasoningProviderEvent {
  const retryable = ["rate_limit_error", "api_error", "timeout_error", "overloaded_error"].includes(errorType);
  return providerFailure(errorType === "rate_limit_error" ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
    "Claude could not complete the reasoning response.", retryable);
}

function providerFailure(code: string, safeMessage: string, retryable: boolean): ReasoningProviderEvent {
  return { type: "response.failed", code, safeMessage, retryable };
}

function parseArguments(value: string): JsonObject | null {
  if (!value || value.length > 100_000) return null;
  try { return objectValue(JSON.parse(value)); } catch { return null; }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function integerValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
