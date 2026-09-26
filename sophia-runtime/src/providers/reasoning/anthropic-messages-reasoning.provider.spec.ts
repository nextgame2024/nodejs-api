import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ToolResult } from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";
import { ReasoningPipeline, type ReasoningPipelineEvent } from "../../platform/orchestration/reasoning-pipeline.js";
import {
  reasoningContractContext,
  reasoningContractTools,
  sseResponse,
  succeededToolResult,
} from "../../../test/fixtures/reasoning-contract.fixture.js";
import { AnthropicMessagesReasoningProvider } from "./anthropic-messages-reasoning.provider.js";

describe("AnthropicMessagesReasoningProvider", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.ANTHROPIC_API_BASE_URL = "https://anthropic.example";
    process.env.ANTHROPIC_REASONING_MODEL = "configured-claude-model";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
    delete process.env.ANTHROPIC_REASONING_MODEL;
  });

  it("maps Claude streaming text, cache-aware usage and configured request fields", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      messageStart({ input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 1 }),
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Grounded answer." }),
      blockStop(0),
      messageDelta("end_turn", 4),
      { type: "message_stop" },
    ]));
    const events = await collect(new ReasoningPipeline(new AnthropicMessagesReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({
      ...reasoningContractContext,
      history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
      userText: "Answer this",
      tools: reasoningContractTools,
    }));

    expect(fetchMock.mock.calls[0][0]).toBe("https://anthropic.example/v1/messages");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "x-api-key": "test-anthropic-key", "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: "configured-claude-model",
      system: reasoningContractContext.instructions,
      stream: true,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    expect(body.messages).toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Answer this" },
    ]);
    expect(body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "sophia_0_catalog_search", strict: true }),
      expect.objectContaining({ name: "sophia_1_booking_prepare", strict: true }),
    ]));
    expect(events).toContainEqual({ type: "usage", usage: {
      inputTokens: 15, outputTokens: 4, totalTokens: 19, cachedInputTokens: 3,
    } });
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "Grounded answer.", toolCalls: 0 });
  });

  it("keeps opaque Claude blocks local and returns failed tool results with is_error", async () => {
    const opaqueThinking = { type: "redacted_thinking", data: "opaque-claude-state" };
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sseResponse([
        messageStart({ input_tokens: 5, output_tokens: 1 }),
        blockStart(0, opaqueThinking), blockStop(0),
        blockStart(1, { type: "tool_use", id: "toolu_1", name: "sophia_0_catalog_search", input: {} }),
        blockDelta(1, { type: "input_json_delta", partial_json: "{\"query\":\"Bulimba\"}" }),
        blockStop(1), messageDelta("tool_use", 3), { type: "message_stop" },
      ]))
      .mockResolvedValueOnce(sseResponse([
        messageStart({ input_tokens: 8, output_tokens: 1 }),
        blockStart(0, { type: "text", text: "" }),
        blockDelta(0, { type: "text_delta", text: "The search is unavailable." }),
        blockStop(0), messageDelta("end_turn", 5), { type: "message_stop" },
      ]));
    const failedResult: ToolResult = {
      toolCallId: "toolu_1", toolId: "catalog.search", capability: "catalog", status: "failed",
      error: { code: "CONNECTOR_UNAVAILABLE", message: "Catalog search is temporarily unavailable.", retryable: true },
    };
    const events = await collect(new ReasoningPipeline(new AnthropicMessagesReasoningProvider(), {
      execute: async () => failedResult,
    }).stream({ ...reasoningContractContext, userText: "Find a property", tools: reasoningContractTools }));

    const followUp = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(followUp.messages.at(-2)).toEqual({ role: "assistant", content: [
      opaqueThinking,
      { type: "tool_use", id: "toolu_1", name: "sophia_0_catalog_search", input: { query: "Bulimba" } },
    ] });
    expect(followUp.messages.at(-1).content[0]).toMatchObject({
      type: "tool_result", tool_use_id: "toolu_1", is_error: true,
    });
    expect(JSON.stringify(events)).not.toContain("opaque-claude-state");
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.requested", call: expect.objectContaining({ name: "catalog.search" }),
    }));
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "The search is unavailable.", toolCalls: 1 });
  });

  it("runs the shared catalog-to-real-estate-review workflow without a Core branch", async () => {
    jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(toolStream("toolu_search", "sophia_0_catalog_search", { query: "Bulimba" }))
      .mockResolvedValueOnce(toolStream("toolu_review", "sophia_1_booking_prepare", { propertyId: "property-1" }))
      .mockResolvedValueOnce(textStream("Please review the displayed booking."));
    const execute = jest.fn(async (call: { callId: string; name: string }) =>
      succeededToolResult(call.callId, call.name, call.name === "catalog.search"
        ? { items: [{ id: "property-1" }] } : { reviewId: "review-1" }));
    const events = await collect(new ReasoningPipeline(new AnthropicMessagesReasoningProvider(), { execute }).stream({
      ...reasoningContractContext, userText: "Book a Bulimba inspection", tools: reasoningContractTools,
    }));

    expect(execute.mock.calls.map(([call]) => call.name)).toEqual(["catalog.search", "booking.prepare"]);
    expect(events.at(-1)).toEqual({
      type: "turn.completed", text: "Please review the displayed booking.", toolCalls: 2,
    });
  });

  it("fails closed on duplicate provider call IDs before tool execution", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      messageStart({ input_tokens: 5, output_tokens: 1 }),
      blockStart(0, { type: "tool_use", id: "toolu_duplicate", name: "sophia_0_catalog_search", input: {} }),
      blockDelta(0, { type: "input_json_delta", partial_json: "{\"query\":\"Bulimba\"}" }), blockStop(0),
      blockStart(1, { type: "tool_use", id: "toolu_duplicate", name: "sophia_1_booking_prepare", input: {} }),
      blockDelta(1, { type: "input_json_delta", partial_json: "{\"propertyId\":\"property-1\"}" }), blockStop(1),
      messageDelta("tool_use", 4), { type: "message_stop" },
    ]));
    const execute = jest.fn(async () => succeededToolResult("unused", "catalog.search", {}));
    const events = await collect(new ReasoningPipeline(new AnthropicMessagesReasoningProvider(), { execute }).stream({
      ...reasoningContractContext, userText: "Search and book", tools: reasoningContractTools,
    }));

    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "REASONING_PIPELINE_FAILED" });
  });

  it("reports missing credentials and retryable provider errors without claiming a live success", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const missing = await collect(new ReasoningPipeline(new AnthropicMessagesReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({ ...reasoningContractContext, userText: "Hello", tools: [] }));
    expect(missing.at(-1)).toMatchObject({ type: "turn.failed", code: "REASONING_PROVIDER_UNAVAILABLE", retryable: false });

    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    jest.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([], 529));
    const overloaded = await collect(new ReasoningPipeline(new AnthropicMessagesReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({ ...reasoningContractContext, userText: "Hello", tools: [] }));
    expect(overloaded.at(-1)).toEqual({
      type: "turn.failed", code: "PROVIDER_UNAVAILABLE",
      safeMessage: "Claude reasoning request failed with status 529.", retryable: true,
    });
  });
});

function messageStart(usage: Record<string, number>) {
  return { type: "message_start", message: { type: "message", role: "assistant", content: [], usage } };
}
function blockStart(index: number, contentBlock: Record<string, unknown>) {
  return { type: "content_block_start", index, content_block: contentBlock };
}
function blockDelta(index: number, delta: Record<string, unknown>) {
  return { type: "content_block_delta", index, delta };
}
function blockStop(index: number) { return { type: "content_block_stop", index }; }
function messageDelta(stopReason: string, outputTokens: number) {
  return { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } };
}
function toolStream(callId: string, name: string, input: Record<string, unknown>): Response {
  return sseResponse([
    messageStart({ input_tokens: 5, output_tokens: 1 }),
    blockStart(0, { type: "tool_use", id: callId, name, input: {} }),
    blockDelta(0, { type: "input_json_delta", partial_json: JSON.stringify(input) }),
    blockStop(0), messageDelta("tool_use", 3), { type: "message_stop" },
  ]);
}
function textStream(text: string): Response {
  return sseResponse([
    messageStart({ input_tokens: 8, output_tokens: 1 }),
    blockStart(0, { type: "text", text: "" }),
    blockDelta(0, { type: "text_delta", text }),
    blockStop(0), messageDelta("end_turn", 5), { type: "message_stop" },
  ]);
}

async function collect(stream: AsyncIterable<ReasoningPipelineEvent>): Promise<ReasoningPipelineEvent[]> {
  const events: ReasoningPipelineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
