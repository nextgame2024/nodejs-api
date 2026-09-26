import { describe, expect, it, jest } from "@jest/globals";
import {
  reasoningContractContext,
  reasoningContractTools,
  ScriptedReasoningProvider,
  succeededToolResult,
} from "../../../test/fixtures/reasoning-contract.fixture.js";
import { ReasoningPipeline, type ReasoningPipelineEvent, type ReasoningToolExecutor } from "./reasoning-pipeline.js";

describe("ReasoningPipeline", () => {
  it("streams neutral text and canonical usage without provider types", async () => {
    const provider = new ScriptedReasoningProvider([[
      { type: "text.delta", delta: "Hello " },
      { type: "text.delta", delta: "there." },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
      { type: "response.completed" },
    ]]);
    const events = await collect(new ReasoningPipeline(provider, executor()).stream({
      ...reasoningContractContext, userText: "Hello", tools: reasoningContractTools,
    }));

    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } });
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "Hello there.", toolCalls: 0 });
    expect(provider.closed).toBe(true);
  });

  it("uses one bounded loop for neutral catalog and real-estate review tools", async () => {
    const provider = new ScriptedReasoningProvider([
      [{ type: "tool.call", call: { callId: "call-search", name: "catalog.search", arguments: { query: "Bulimba" } } }, { type: "response.completed" }],
      [{ type: "tool.call", call: { callId: "call-review", name: "booking.prepare", arguments: { propertyId: "property-1" } } }, { type: "response.completed" }],
      [{ type: "text.delta", delta: "Please review the displayed booking." }, { type: "response.completed" }],
    ]);
    const execute = jest.fn<ReasoningToolExecutor["execute"]>(async (call) =>
      succeededToolResult(call.callId, call.name, call.name === "catalog.search" ? { items: [{ id: "property-1" }] } : { reviewId: "review-1" }));
    const events = await collect(new ReasoningPipeline(provider, { execute }).stream({
      ...reasoningContractContext, userText: "Book a Bulimba inspection", tools: reasoningContractTools,
    }));

    expect(execute.mock.calls.map(([call]) => call.name)).toEqual(["catalog.search", "booking.prepare"]);
    expect(provider.inputs.slice(1).every((input) => input.type === "tool_outputs")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "Please review the displayed booking.", toolCalls: 2 });
  });

  it("allows the terminal response after the configured final tool round", async () => {
    const provider = new ScriptedReasoningProvider([
      [{ type: "tool.call", call: { callId: "call-search", name: "catalog.search", arguments: { query: "Bulimba" } } }, { type: "response.completed" }],
      [{ type: "text.delta", delta: "Search complete." }, { type: "response.completed" }],
    ]);
    const events = await collect(new ReasoningPipeline(provider, executor()).stream({
      ...reasoningContractContext, userText: "Search", tools: reasoningContractTools, maximumToolRounds: 1,
    }));

    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "Search complete.", toolCalls: 1 });
  });

  it("returns a failed tool result to the provider once without bypassing the loop", async () => {
    const provider = new ScriptedReasoningProvider([
      [{ type: "tool.call", call: { callId: "call-search", name: "catalog.search", arguments: { query: "Bulimba" } } }, { type: "response.completed" }],
      [{ type: "text.delta", delta: "Search unavailable." }, { type: "response.completed" }],
    ]);
    const execute = jest.fn<ReasoningToolExecutor["execute"]>(async (call) => ({
      toolCallId: call.callId, toolId: call.name, capability: "catalog", status: "failed",
      error: { code: "CONNECTOR_UNAVAILABLE", message: "Catalog unavailable.", retryable: true },
    }));
    const events = await collect(new ReasoningPipeline(provider, { execute }).stream({
      ...reasoningContractContext, userText: "Search", tools: reasoningContractTools,
    }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider.inputs[1]).toMatchObject({ type: "tool_outputs", outputs: [{
      callId: "call-search", output: { status: "failed" },
    }] });
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "Search unavailable.", toolCalls: 1 });
  });

  it("rejects duplicate provider call IDs before either call executes", async () => {
    const provider = new ScriptedReasoningProvider([[
      { type: "tool.call", call: { callId: "duplicate", name: "catalog.search", arguments: { query: "Bulimba" } } },
      { type: "tool.call", call: { callId: "duplicate", name: "booking.prepare", arguments: { propertyId: "property-1" } } },
      { type: "response.completed" },
    ]]);
    const execute = jest.fn<ReasoningToolExecutor["execute"]>();
    const events = await collect(new ReasoningPipeline(provider, { execute }).stream({
      ...reasoningContractContext, userText: "Search and book", tools: reasoningContractTools,
    }));

    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", code: "REASONING_PIPELINE_FAILED" });
  });

  it("maps cancellation, provider errors and invalid calls to canonical terminal events", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const cancelledEvents = await collect(new ReasoningPipeline(new ScriptedReasoningProvider([]), executor()).stream({
      ...reasoningContractContext, userText: "Stop", tools: [], signal: cancelled.signal,
    }));
    expect(cancelledEvents.at(-1)).toEqual({ type: "turn.cancelled" });

    const failed = await collect(new ReasoningPipeline(new ScriptedReasoningProvider([[
      { type: "response.failed", code: "RATE_LIMITED", safeMessage: "Try later.", retryable: true },
    ]]), executor()).stream({ ...reasoningContractContext, userText: "Hello", tools: [] }));
    expect(failed.at(-1)).toEqual({ type: "turn.failed", code: "RATE_LIMITED", safeMessage: "Try later.", retryable: true });

    const invalid = await collect(new ReasoningPipeline(new ScriptedReasoningProvider([[
      { type: "tool.call", call: { callId: "bad", name: "catalog.search", arguments: [] as never } },
      { type: "response.completed" },
    ]]), executor()).stream({ ...reasoningContractContext, userText: "Hello", tools: reasoningContractTools }));
    expect(invalid.at(-1)).toMatchObject({ type: "turn.failed", code: "REASONING_PIPELINE_FAILED" });
  });
});

function executor(): ReasoningToolExecutor {
  return { execute: async (call) => succeededToolResult(call.callId, call.name, {}) };
}

async function collect(stream: AsyncIterable<ReasoningPipelineEvent>): Promise<ReasoningPipelineEvent[]> {
  const events: ReasoningPipelineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
