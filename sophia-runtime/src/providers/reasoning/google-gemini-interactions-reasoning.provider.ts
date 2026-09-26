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
export class GoogleGeminiInteractionsReasoningProvider implements ReasoningProvider {
  async open(request: OpenReasoningSessionRequest): Promise<ReasoningProviderSession> {
    const config = runtimeConfig().googleGemini;
    if (!config.apiKey) throw new Error("Gemini reasoning is unavailable because GEMINI_API_KEY is not configured.");
    request.tools.forEach((tool) => validateGeminiSchema(tool.name, tool.inputSchema));
    return new GoogleGeminiInteractionsReasoningSession({
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maximumOutputTokens: config.maximumOutputTokens,
      request,
    });
  }
}

class GoogleGeminiInteractionsReasoningSession implements ReasoningProviderSession {
  private history: JsonObject[];
  private firstRequest = true;
  private readonly providerToolNames: Map<string, string>;
  private readonly canonicalToolNames: Map<string, string>;
  private readonly providerNamesByCallId = new Map<string, string>();

  constructor(private readonly options: {
    apiKey: string;
    apiBaseUrl: string;
    model: string;
    timeoutMs: number;
    maximumOutputTokens: number;
    request: OpenReasoningSessionRequest;
  }) {
    this.history = options.request.history.map((message) => message.role === "user"
      ? userInputStep(message.content) : modelOutputStep(message.content));
    const aliases = toolAliases(options.request.tools);
    this.providerToolNames = aliases.providerByCanonical;
    this.canonicalToolNames = aliases.canonicalByProvider;
  }

  async *stream(input: ReasoningProviderInput, signal: AbortSignal): AsyncGenerator<ReasoningProviderEvent> {
    this.appendInput(input);
    const response = await fetch(`${this.options.apiBaseUrl.replace(/\/+$/, "")}/interactions`, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.options.apiKey,
        "content-type": "application/json",
        accept: "text/event-stream",
        "api-revision": "2026-05-20",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      body: JSON.stringify({
        model: this.options.model,
        input: this.history,
        system_instruction: this.options.request.instructions,
        tools: this.options.request.tools.map((tool) => geminiTool(tool, this.providerToolNames.get(tool.name)!)),
        generation_config: {
          max_output_tokens: this.options.maximumOutputTokens,
          thinking_summaries: "none",
        },
        tool_choice: "auto",
        stream: true,
        store: false,
      }),
    });
    if (!response.ok || !response.body) {
      yield httpFailure(response.status);
      return;
    }

    const steps = new Map<number, JsonObject>();
    const argumentDeltas = new Map<number, string>();
    let toolCalls = 0;
    let completed = false;

    for await (const event of responseEvents(response.body)) {
      const eventType = stringValue(event["event_type"]) || stringValue(event["type"]);
      if (eventType === "step.start") {
        const index = integerValue(event["index"]);
        const step = objectValue(event["step"]);
        if (index !== null && step) {
          const initial = structuredClone(step);
          steps.set(index, initial);
          if (initial["type"] === "model_output") {
            for (const text of textContents(initial["content"])) yield { type: "text.delta", delta: text };
          }
        }
      } else if (eventType === "step.delta") {
        const index = integerValue(event["index"]);
        const delta = objectValue(event["delta"]);
        const step = index === null ? null : steps.get(index);
        if (index === null || !delta || !step) continue;
        const deltaType = stringValue(delta["type"]);
        if (deltaType === "text" && step["type"] === "model_output") {
          const text = stringValue(delta["text"]);
          if (text) {
            appendTextContent(step, text);
            yield { type: "text.delta", delta: text };
          }
        } else if (deltaType === "arguments_delta" && step["type"] === "function_call") {
          argumentDeltas.set(index, `${argumentDeltas.get(index) ?? ""}${stringValue(delta["arguments"])}`);
        } else if (deltaType === "thought_signature" && step["type"] === "thought") {
          const signature = stringValue(delta["signature"]);
          if (signature) step["signature"] = signature;
        } else if (deltaType === "thought_summary" && step["type"] === "thought") {
          const content = objectValue(delta["content"]);
          if (content) step["summary"] = [...arrayValue(step["summary"]), structuredClone(content)];
        } else if (deltaType === "text_annotation_delta" && step["type"] === "model_output") {
          appendTextAnnotations(step, arrayValue(delta["annotations"]));
        }
      } else if (eventType === "step.stop") {
        const index = integerValue(event["index"]);
        const step = index === null ? null : steps.get(index);
        if (index === null || step?.["type"] !== "function_call") continue;
        const callId = stringValue(step["id"]);
        const providerName = stringValue(step["name"]);
        const name = this.canonicalToolNames.get(providerName);
        const parsed = parseArguments(argumentDeltas.get(index), step["arguments"]);
        if (!callId || !name || !parsed) {
          yield providerFailure("INVALID_PROVIDER_EVENT", "Gemini returned an invalid tool call.", false);
          return;
        }
        step["arguments"] = parsed;
        this.providerNamesByCallId.set(callId, providerName);
        toolCalls += 1;
        yield { type: "tool.call", call: { callId, name, arguments: parsed } };
      } else if (eventType === "interaction.completed") {
        const interaction = objectValue(event["interaction"]);
        const status = stringValue(interaction?.["status"]);
        if (!validCompletion(status, toolCalls)) {
          yield providerFailure(status === "incomplete" ? "INCOMPLETE_RESPONSE" : "INVALID_PROVIDER_EVENT",
            status === "incomplete" ? "Gemini reached a configured response limit." : "Gemini returned an incomplete reasoning response.", false);
          return;
        }
        const usage = usageValue(interaction?.["usage"]);
        if (!usage) {
          yield providerFailure("INVALID_PROVIDER_EVENT", "Gemini returned invalid usage data.", false);
          return;
        }
        this.history.push(...[...steps.entries()].sort(([a], [b]) => a - b).map(([, step]) => step));
        yield { type: "usage", usage };
        yield { type: "response.completed" };
        completed = true;
        return;
      } else if (eventType === "error") {
        yield streamFailure(stringValue(objectValue(event["error"])?.["code"]));
        return;
      }
    }
    if (!completed) yield providerFailure("INVALID_PROVIDER_EVENT", "Gemini ended the stream without completing the interaction.", true);
  }

  async close(): Promise<void> {
    this.history = [];
    this.providerNamesByCallId.clear();
  }

  private appendInput(input: ReasoningProviderInput): void {
    if (input.type === "user") {
      if (!this.firstRequest) throw new Error("A reasoning provider session accepts one initial user turn.");
      this.firstRequest = false;
      this.history.push(userInputStep(input.text));
      return;
    }
    if (this.firstRequest || !this.history.length) throw new Error("Tool outputs require a completed provider response.");
    this.history.push(...input.outputs.map((output) => {
      const name = this.providerNamesByCallId.get(output.callId);
      if (!name) throw new Error(`Gemini tool output references unknown call ID ${output.callId}.`);
      return {
        type: "function_result",
        name,
        call_id: output.callId,
        result: [{ type: "text", text: JSON.stringify(output.output) }],
        ...(toolResultIsError(output.output) ? { is_error: true } : {}),
      };
    }));
  }
}

function geminiTool(tool: ReasoningToolDefinition, providerName: string): JsonObject {
  return { type: "function", name: providerName, description: tool.description, parameters: tool.inputSchema };
}

function userInputStep(text: string): JsonObject {
  return { type: "user_input", content: [{ type: "text", text }] };
}

function modelOutputStep(text: string): JsonObject {
  return { type: "model_output", content: [{ type: "text", text }] };
}

function appendTextContent(step: JsonObject, text: string): void {
  const content = arrayValue(step["content"]);
  const last = objectValue(content.at(-1));
  if (last?.["type"] === "text") last["text"] = `${stringValue(last["text"])}${text}`;
  else content.push({ type: "text", text });
  step["content"] = content;
}

function appendTextAnnotations(step: JsonObject, annotations: unknown[]): void {
  const content = arrayValue(step["content"]);
  const last = objectValue(content.at(-1));
  if (last?.["type"] === "text" && annotations.length) {
    last["annotations"] = [...arrayValue(last["annotations"]), ...structuredClone(annotations)];
  }
}

function textContents(value: unknown): string[] {
  return arrayValue(value).map(objectValue).filter((content): content is JsonObject => content?.["type"] === "text")
    .map((content) => stringValue(content["text"])).filter(Boolean);
}

function toolAliases(tools: readonly ReasoningToolDefinition[]): {
  providerByCanonical: Map<string, string>;
  canonicalByProvider: Map<string, string>;
} {
  const providerByCanonical = new Map<string, string>();
  const canonicalByProvider = new Map<string, string>();
  tools.forEach((tool, index) => {
    const semanticName = tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
    const providerName = `sophia_${index}_${semanticName}`.slice(0, 64);
    providerByCanonical.set(tool.name, providerName);
    canonicalByProvider.set(providerName, tool.name);
  });
  return { providerByCanonical, canonicalByProvider };
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems",
  "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required",
  "propertyOrdering",
]);

export function validateGeminiSchema(toolName: string, schema: unknown, path = "parameters"): void {
  const value = objectValue(schema);
  if (!value) throw new Error(`Gemini tool ${toolName} has a non-object schema at ${path}.`);
  for (const [keyword, child] of Object.entries(value)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`Gemini tool ${toolName} uses unsupported JSON Schema keyword ${path}.${keyword}.`);
    }
    if (keyword === "properties" || keyword === "$defs") {
      const properties = objectValue(child);
      if (!properties) throw new Error(`Gemini tool ${toolName} has invalid schema object at ${path}.${keyword}.`);
      for (const [name, propertySchema] of Object.entries(properties)) validateGeminiSchema(toolName, propertySchema, `${path}.${keyword}.${name}`);
    } else if (keyword === "items" || keyword === "additionalProperties") {
      if (typeof child !== "boolean") validateGeminiSchema(toolName, child, `${path}.${keyword}`);
    } else if (keyword === "prefixItems" || keyword === "anyOf" || keyword === "oneOf") {
      if (!Array.isArray(child)) throw new Error(`Gemini tool ${toolName} has invalid schema array at ${path}.${keyword}.`);
      child.forEach((item, index) => validateGeminiSchema(toolName, item, `${path}.${keyword}[${index}]`));
    }
  }
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

function usageValue(value: unknown) {
  const usage = objectValue(value);
  if (!usage) return null;
  const inputTokens = numberValue(usage["total_input_tokens"]);
  const outputTokens = numberValue(usage["total_output_tokens"]);
  const totalTokens = numberValue(usage["total_tokens"]);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  const cachedInputTokens = numberValue(usage["total_cached_tokens"]);
  const reasoningTokens = numberValue(usage["total_thought_tokens"]);
  return { inputTokens, outputTokens, totalTokens,
    ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
    ...(reasoningTokens === null ? {} : { reasoningTokens }) };
}

function validCompletion(status: string, toolCalls: number): boolean {
  return toolCalls > 0 ? status === "requires_action" : status === "completed";
}

function toolResultIsError(value: unknown): boolean {
  return ["failed", "denied", "cancelled", "outcome_unknown"].includes(stringValue(objectValue(value)?.["status"]));
}

function httpFailure(status: number): ReasoningProviderEvent {
  const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  const code = status === 429 ? "RATE_LIMITED"
    : status === 401 || status === 403 ? "PROVIDER_AUTHENTICATION_FAILED"
      : status >= 400 && status < 500 ? "INVALID_PROVIDER_REQUEST" : "PROVIDER_UNAVAILABLE";
  return providerFailure(code, `Gemini reasoning request failed with status ${status}.`, retryable);
}

function streamFailure(code: string): ReasoningProviderEvent {
  const retryable = ["gateway_timeout", "deadline_exceeded", "resource_exhausted", "unavailable", "internal"].includes(code);
  return providerFailure(code === "resource_exhausted" ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
    "Gemini could not complete the reasoning response.", retryable);
}

function providerFailure(code: string, safeMessage: string, retryable: boolean): ReasoningProviderEvent {
  return { type: "response.failed", code, safeMessage, retryable };
}

function parseArguments(delta: string | undefined, initial: unknown): JsonObject | null {
  if (delta === undefined || delta === "") return objectValue(initial);
  if (delta.length > 100_000) return null;
  try { return objectValue(JSON.parse(delta)); } catch { return null; }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function integerValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
