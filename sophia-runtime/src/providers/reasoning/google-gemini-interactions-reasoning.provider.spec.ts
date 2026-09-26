import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ToolResult } from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";
import { ReasoningPipeline, type ReasoningPipelineEvent } from "../../platform/orchestration/reasoning-pipeline.js";
import {
  reasoningContractContext,
  reasoningContractTools,
  sseResponse,
  succeededToolResult,
} from "../../../test/fixtures/reasoning-contract.fixture.js";
import { GoogleGeminiInteractionsReasoningProvider } from "./google-gemini-interactions-reasoning.provider.js";

describe("GoogleGeminiInteractionsReasoningProvider", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_API_BASE_URL = "https://gemini.example/v1beta";
    process.env.GEMINI_REASONING_MODEL = "configured-gemini-model";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_BASE_URL;
    delete process.env.GEMINI_REASONING_MODEL;
  });

  it("maps Gemini streaming text, thinking-aware usage and configured stateless request fields", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(textStream("answer.", {
      total_input_tokens: 10, total_output_tokens: 4, total_tokens: 18,
      total_cached_tokens: 3, total_thought_tokens: 4,
    }, "Grounded "));
    const events = await collect(new ReasoningPipeline(new GoogleGeminiInteractionsReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({
      ...reasoningContractContext,
      history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
      userText: "Answer this",
      tools: reasoningContractTools,
    }));

    expect(fetchMock.mock.calls[0][0]).toBe("https://gemini.example/v1beta/interactions");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "x-goog-api-key": "test-gemini-key", "api-revision": "2026-05-20",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: "configured-gemini-model",
      system_instruction: reasoningContractContext.instructions,
      generation_config: { max_output_tokens: 4096, thinking_summaries: "none" },
      tool_choice: "auto",
      stream: true,
      store: false,
    });
    expect(body.input).toEqual([
      userStep("Earlier question"), modelStep("Earlier answer"), userStep("Answer this"),
    ]);
    expect(body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "sophia_0_catalog_search" }),
      expect.objectContaining({ type: "function", name: "sophia_1_booking_prepare" }),
    ]));
    expect(events).toContainEqual({ type: "usage", usage: {
      inputTokens: 10, outputTokens: 4, totalTokens: 18, cachedInputTokens: 3, reasoningTokens: 4,
    } });
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "Grounded answer.", toolCalls: 0 });
  });

  it("keeps Gemini thought signatures local and marks failed function results", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(toolStream("call_1", "sophia_0_catalog_search", { query: "Bulimba" }, "opaque-signature"))
      .mockResolvedValueOnce(textStream("The search is unavailable."));
    const failedResult: ToolResult = {
      toolCallId: "call_1", toolId: "catalog.search", capability: "catalog", status: "failed",
      error: { code: "CONNECTOR_UNAVAILABLE", message: "Catalog search is temporarily unavailable.", retryable: true },
    };
    const events = await collect(new ReasoningPipeline(new GoogleGeminiInteractionsReasoningProvider(), {
      execute: async () => failedResult,
    }).stream({ ...reasoningContractContext, userText: "Find a property", tools: reasoningContractTools }));

    const followUp = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(followUp.input.slice(-3)).toEqual([
      { type: "thought", signature: "opaque-signature" },
      { type: "function_call", id: "call_1", name: "sophia_0_catalog_search", arguments: { query: "Bulimba" } },
      expect.objectContaining({ type: "function_result", name: "sophia_0_catalog_search", call_id: "call_1", is_error: true }),
    ]);
    expect(JSON.stringify(events)).not.toContain("opaque-signature");
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.requested", call: expect.objectContaining({ name: "catalog.search" }),
    }));
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "The search is unavailable.", toolCalls: 1 });
  });

  it("runs the shared catalog-to-real-estate-review workflow without a Core branch", async () => {
    jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(toolStream("call_search", "sophia_0_catalog_search", { query: "Bulimba" }))
      .mockResolvedValueOnce(toolStream("call_review", "sophia_1_booking_prepare", { propertyId: "property-1" }))
      .mockResolvedValueOnce(textStream("Please review the displayed booking."));
    const execute = jest.fn(async (call: { callId: string; name: string }) =>
      succeededToolResult(call.callId, call.name, call.name === "catalog.search"
        ? { items: [{ id: "property-1" }] } : { reviewId: "review-1" }));
    const events = await collect(new ReasoningPipeline(new GoogleGeminiInteractionsReasoningProvider(), { execute }).stream({
      ...reasoningContractContext, userText: "Book a Bulimba inspection", tools: reasoningContractTools,
    }));

    expect(execute.mock.calls.map(([call]) => call.name)).toEqual(["catalog.search", "booking.prepare"]);
    expect(events.at(-1)).toEqual({
      type: "turn.completed", text: "Please review the displayed booking.", toolCalls: 2,
    });
  });

  it("fails closed on duplicate provider call IDs before tool execution", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      start(0, { type: "function_call", id: "duplicate", name: "sophia_0_catalog_search", arguments: {} }),
      delta(0, { type: "arguments_delta", arguments: "{\"query\":\"Bulimba\"}" }), stop(0),
      start(1, { type: "function_call", id: "duplicate", name: "sophia_1_booking_prepare", arguments: {} }),
      delta(1, { type: "arguments_delta", arguments: "{\"propertyId\":\"property-1\"}" }), stop(1),
      completed("requires_action"),
    ]));
    const execute = jest.fn(async () => succeededToolResult("unused", "catalog.search", {}));
    const events = await collect(new ReasoningPipeline(new GoogleGeminiInteractionsReasoningProvider(), { execute }).stream({
      ...reasoningContractContext, userText: "Search and book", tools: reasoningContractTools,
    }));

    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "REASONING_PIPELINE_FAILED" });
  });

  it("rejects unsupported Gemini schema keywords before sending a request", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch");
    const events = await collect(new ReasoningPipeline(new GoogleGeminiInteractionsReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({
      ...reasoningContractContext,
      userText: "Use an unsupported schema",
      tools: [{ name: "unsupported.tool", description: "Test", inputSchema: {
        type: "object", properties: { value: { type: "string", pattern: "^[a-z]+$" } },
      } }],
    }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "REASONING_PROVIDER_UNAVAILABLE" });
  });

  it("reports missing credentials and retryable provider errors without claiming a live success", async () => {
    delete process.env.GEMINI_API_KEY;
    const missing = await collect(new ReasoningPipeline(new GoogleGeminiInteractionsReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({ ...reasoningContractContext, userText: "Hello", tools: [] }));
    expect(missing.at(-1)).toMatchObject({ type: "turn.failed", code: "REASONING_PROVIDER_UNAVAILABLE", retryable: false });

    process.env.GEMINI_API_KEY = "test-gemini-key";
    jest.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([], 503));
    const unavailable = await collect(new ReasoningPipeline(new GoogleGeminiInteractionsReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({ ...reasoningContractContext, userText: "Hello", tools: [] }));
    expect(unavailable.at(-1)).toEqual({
      type: "turn.failed", code: "PROVIDER_UNAVAILABLE",
      safeMessage: "Gemini reasoning request failed with status 503.", retryable: true,
    });
  });
});

function start(index: number, step: Record<string, unknown>) { return { event_type: "step.start", index, step }; }
function delta(index: number, value: Record<string, unknown>) { return { event_type: "step.delta", index, delta: value }; }
function stop(index: number) { return { event_type: "step.stop", index }; }
function completed(status: "completed" | "requires_action", usage = {
  total_input_tokens: 5, total_output_tokens: 3, total_tokens: 8, total_cached_tokens: 0, total_thought_tokens: 0,
}) { return { event_type: "interaction.completed", interaction: { status, usage } }; }
function toolStream(callId: string, name: string, args: Record<string, unknown>, signature?: string): Response {
  return sseResponse([
    ...(signature ? [start(0, { type: "thought" }), delta(0, { type: "thought_signature", signature }), stop(0)] : []),
    start(signature ? 1 : 0, { type: "function_call", id: callId, name, arguments: {} }),
    delta(signature ? 1 : 0, { type: "arguments_delta", arguments: JSON.stringify(args) }), stop(signature ? 1 : 0),
    completed("requires_action"),
  ]);
}
function textStream(text: string, usage?: Record<string, number>, initialText = ""): Response {
  return sseResponse([
    start(0, { type: "model_output", content: initialText ? [{ type: "text", text: initialText }] : [] }),
    delta(0, { type: "text", text }), stop(0),
    completed("completed", usage as never),
  ]);
}
function userStep(text: string) { return { type: "user_input", content: [{ type: "text", text }] }; }
function modelStep(text: string) { return { type: "model_output", content: [{ type: "text", text }] }; }

async function collect(stream: AsyncIterable<ReasoningPipelineEvent>): Promise<ReasoningPipelineEvent[]> {
  const events: ReasoningPipelineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
