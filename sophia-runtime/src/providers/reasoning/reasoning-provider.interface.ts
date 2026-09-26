export type CanonicalConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ReasoningToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ReasoningToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ReasoningToolOutput = {
  callId: string;
  output: unknown;
};

export type ReasoningUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

export type ReasoningProviderEvent =
  | { type: "text.delta"; delta: string }
  | { type: "tool.call"; call: ReasoningToolCall }
  | { type: "usage"; usage: ReasoningUsage }
  | { type: "response.completed" }
  | { type: "response.failed"; code: string; safeMessage: string; retryable: boolean };

export type ReasoningProviderInput =
  | { type: "user"; text: string }
  | { type: "tool_outputs"; outputs: ReasoningToolOutput[] };

export type OpenReasoningSessionRequest = {
  sessionId: string;
  instructions: string;
  history: readonly CanonicalConversationMessage[];
  tools: readonly ReasoningToolDefinition[];
};

export interface ReasoningProviderSession {
  stream(input: ReasoningProviderInput, signal: AbortSignal): AsyncIterable<ReasoningProviderEvent>;
  close(): Promise<void>;
}

/** Provider-neutral text/tool reasoning boundary. Speech and avatar ownership are separate. */
export interface ReasoningProvider {
  open(request: OpenReasoningSessionRequest): Promise<ReasoningProviderSession>;
}
