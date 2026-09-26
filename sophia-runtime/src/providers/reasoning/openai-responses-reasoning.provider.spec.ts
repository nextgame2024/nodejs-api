import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ReasoningPipeline, type ReasoningPipelineEvent } from "../../platform/orchestration/reasoning-pipeline.js";
import {
  reasoningContractContext,
  reasoningContractTools,
  sseResponse,
  succeededToolResult,
} from "../../../test/fixtures/reasoning-contract.fixture.js";
import { OpenAIResponsesReasoningProvider } from "./openai-responses-reasoning.provider.js";

describe("OpenAIResponsesReasoningProvider", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_REASONING_MODEL = "configured-reasoning-model";
  });
  afterEach(() => jest.restoreAllMocks());

  it("maps Responses streaming text, usage and configured model without exposing vendor events", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse([
      { type: "response.output_text.delta", delta: "Grounded answer." },
      { type: "response.completed", response: { output: [{ type: "message" }], usage: {
        input_tokens: 12, output_tokens: 4, total_tokens: 16,
        input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 },
      } } },
    ]));
    const events = await collect(new ReasoningPipeline(new OpenAIResponsesReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, {}),
    }).stream({ ...reasoningContractContext, userText: "Answer this", tools: reasoningContractTools }));

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: "configured-reasoning-model", stream: true, store: false,
      parallel_tool_calls: false, include: ["reasoning.encrypted_content"] });
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "sophia_0_catalog_search", "sophia_1_booking_prepare",
    ]);
    expect(body.tools.every((tool: { strict: boolean }) => tool.strict === false)).toBe(true);
    expect(events).toContainEqual({ type: "usage", usage: {
      inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 2, reasoningTokens: 1,
    } });
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "Grounded answer.", toolCalls: 0 });
  });

  it("keeps opaque continuation items inside the adapter while returning secured tool outputs", async () => {
    const reasoningItem = { type: "reasoning", encrypted_content: "opaque-provider-state" };
    const functionCall = { type: "function_call", id: "fc-1", call_id: "call-1", name: "sophia_0_catalog_search", arguments: "{\"query\":\"Bulimba\"}" };
    const fetchMock = jest.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sseResponse([
        { type: "response.output_item.done", item: functionCall },
        { type: "response.completed", response: { output: [reasoningItem, functionCall], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
      ]))
      .mockResolvedValueOnce(sseResponse([
        { type: "response.output_text.delta", delta: "One property found." },
        { type: "response.completed", response: { output: [{ type: "message" }], usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } },
      ]));
    const events = await collect(new ReasoningPipeline(new OpenAIResponsesReasoningProvider(), {
      execute: async (call) => succeededToolResult(call.callId, call.name, { items: [{ id: "property-1" }] }),
    }).stream({ ...reasoningContractContext, userText: "Find a property", tools: reasoningContractTools }));

    const followUp = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(followUp.input[0]).toEqual(reasoningItem);
    expect(followUp.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call-1" });
    expect(JSON.stringify(events)).not.toContain("opaque-provider-state");
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.requested", call: expect.objectContaining({ name: "catalog.search" }),
    }));
    expect(events.at(-1)).toEqual({ type: "turn.completed", text: "One property found.", toolCalls: 1 });
  });
});

async function collect(stream: AsyncIterable<ReasoningPipelineEvent>): Promise<ReasoningPipelineEvent[]> {
  const events: ReasoningPipelineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
