import { randomUUID } from "node:crypto";
import type { ToolResult } from "../contracts/v2/sophia-runtime-v2.contracts.js";
import type {
  CanonicalConversationMessage,
  ReasoningProvider,
  ReasoningProviderInput,
  ReasoningToolCall,
  ReasoningToolDefinition,
  ReasoningUsage,
} from "../../providers/reasoning/reasoning-provider.interface.js";

export type ReasoningExecutionContext = {
  customerId: string;
  sessionId: string;
  storeId?: string;
  sessionAccessToken: string;
  correlationId?: string;
};

export interface ReasoningToolExecutor {
  execute(call: ReasoningToolCall, context: ReasoningExecutionContext): Promise<ToolResult>;
}

export type ReasoningPipelineRequest = ReasoningExecutionContext & {
  instructions: string;
  history?: readonly CanonicalConversationMessage[];
  userText: string;
  tools: readonly ReasoningToolDefinition[];
  maximumToolRounds?: number;
  maximumToolCalls?: number;
  signal?: AbortSignal;
};

export type ReasoningPipelineEvent =
  | { type: "assistant.text.delta"; delta: string }
  | { type: "tool.requested"; call: ReasoningToolCall }
  | { type: "tool.completed"; call: ReasoningToolCall; result: ToolResult }
  | { type: "usage"; usage: ReasoningUsage }
  | { type: "turn.completed"; text: string; toolCalls: number }
  | { type: "turn.cancelled" }
  | { type: "turn.failed"; code: string; safeMessage: string; retryable: boolean };

export class ReasoningPipeline {
  constructor(
    private readonly provider: ReasoningProvider,
    private readonly tools: ReasoningToolExecutor,
  ) {}

  async *stream(request: ReasoningPipelineRequest): AsyncGenerator<ReasoningPipelineEvent> {
    const signal = request.signal ?? new AbortController().signal;
    const maximumRounds = boundedInteger(request.maximumToolRounds, 1, 12, 6);
    const maximumCalls = boundedInteger(request.maximumToolCalls, 1, 32, 12);
    const correlationId = request.correlationId ?? randomUUID();
    let session;
    let input: ReasoningProviderInput;
    try {
      session = await this.provider.open({
        sessionId: request.sessionId,
        instructions: boundedText(request.instructions, 40_000, "Instructions"),
        history: boundedHistory(request.history ?? []),
        tools: validateTools(request.tools),
      });
      input = { type: "user", text: boundedText(request.userText, 20_000, "User text") };
    } catch (error) {
      yield { type: "turn.failed", code: "REASONING_PROVIDER_UNAVAILABLE", safeMessage: safeError(error), retryable: false };
      return;
    }
    let text = "";
    let toolCalls = 0;
    let toolRounds = 0;

    try {
      while (true) {
        if (signal.aborted) {
          yield { type: "turn.cancelled" };
          return;
        }
        const pending: ReasoningToolCall[] = [];
        let providerCompleted = false;
        for await (const event of session.stream(input, signal)) {
          if (signal.aborted) {
            yield { type: "turn.cancelled" };
            return;
          }
          if (event.type === "text.delta") {
            const delta = boundedDelta(event.delta, 40_000);
            text += delta;
            if (text.length > 100_000) throw new Error("Reasoning output exceeded the bounded turn size.");
            yield { type: "assistant.text.delta", delta };
          } else if (event.type === "tool.call") {
            const call = validateCall(event.call);
            if (pending.some((candidate) => candidate.callId === call.callId)) {
              throw new Error("The reasoning provider emitted a duplicate tool call ID.");
            }
            pending.push(call);
          } else if (event.type === "usage") {
            yield event;
          } else if (event.type === "response.failed") {
            yield { type: "turn.failed", code: event.code, safeMessage: event.safeMessage, retryable: event.retryable };
            return;
          } else if (event.type === "response.completed") {
            providerCompleted = true;
          }
        }
        if (!providerCompleted) throw new Error("The reasoning provider stream ended without a terminal event.");
        if (!pending.length) {
          yield { type: "turn.completed", text, toolCalls };
          return;
        }
        if (toolRounds >= maximumRounds) {
          throw new Error("The reasoning turn exceeded its tool-round limit.");
        }
        toolRounds += 1;
        if (toolCalls + pending.length > maximumCalls) {
          throw new Error("The reasoning turn exceeded its tool-call limit.");
        }
        const outputs = [];
        for (const call of pending) {
          if (signal.aborted) {
            yield { type: "turn.cancelled" };
            return;
          }
          toolCalls += 1;
          yield { type: "tool.requested", call };
          const result = await this.tools.execute(call, {
            customerId: request.customerId,
            sessionId: request.sessionId,
            storeId: request.storeId,
            sessionAccessToken: request.sessionAccessToken,
            correlationId,
          });
          yield { type: "tool.completed", call, result };
          outputs.push({ callId: call.callId, output: result });
        }
        input = { type: "tool_outputs", outputs };
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        yield { type: "turn.cancelled" };
        return;
      }
      yield {
        type: "turn.failed",
        code: "REASONING_PIPELINE_FAILED",
        safeMessage: safeError(error),
        retryable: false,
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}

function validateTool(tool: ReasoningToolDefinition): ReasoningToolDefinition {
  return {
    name: identifier(tool.name, "Tool name"),
    description: boundedText(tool.description, 2_000, "Tool description"),
    inputSchema: objectValue(tool.inputSchema, "Tool input schema"),
  };
}

function validateTools(tools: readonly ReasoningToolDefinition[]): ReasoningToolDefinition[] {
  if (tools.length > 128) throw new Error("A reasoning turn cannot expose more than 128 tools.");
  const validated = tools.map(validateTool);
  if (new Set(validated.map((tool) => tool.name)).size !== validated.length) {
    throw new Error("Reasoning tool names must be unique.");
  }
  return validated;
}

function validateCall(call: ReasoningToolCall): ReasoningToolCall {
  return {
    callId: identifier(call.callId, "Tool call ID"),
    name: identifier(call.name, "Tool call name"),
    arguments: objectValue(call.arguments, "Tool arguments"),
  };
}

function boundedHistory(history: readonly CanonicalConversationMessage[]): CanonicalConversationMessage[] {
  if (history.length > 100) throw new Error("Canonical history exceeds 100 messages.");
  return history.map((message) => ({ role: message.role, content: boundedText(message.content, 20_000, "History message") }));
}

function boundedText(value: string, maximum: number, label: string): string {
  const text = value.trim();
  if (!text || text.length > maximum) throw new Error(`${label} must contain between 1 and ${maximum} characters.`);
  return text;
}

function boundedDelta(value: string, maximum: number): string {
  if (!value || value.length > maximum) throw new Error(`Text delta must contain between 1 and ${maximum} characters.`);
  return value;
}

function identifier(value: string, label: string): string {
  const text = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return value === undefined ? fallback : Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "The reasoning turn failed.").slice(0, 1_000);
}
