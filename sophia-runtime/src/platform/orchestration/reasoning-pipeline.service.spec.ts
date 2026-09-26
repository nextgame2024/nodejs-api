import { describe, expect, it, jest } from "@jest/globals";
import { ScriptedReasoningProvider } from "../../../test/fixtures/reasoning-contract.fixture.js";
import { ReasoningPipelineService } from "./reasoning-pipeline.service.js";

const request = {
  customerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  sessionAccessToken: "token", correlationId: "turn-1", instructions: "Be helpful.",
  userText: "Hello", tools: [],
};

describe("ReasoningPipelineService usage accountability", () => {
  it("records measured provider usage with a stable source identity", async () => {
    const provider = new ScriptedReasoningProvider([[
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: "response.completed" },
    ]]);
    const record = jest.fn().mockResolvedValue({});
    const service = new ReasoningPipelineService(registry(provider) as never, { execute: jest.fn() } as never, { record } as never);
    for await (const _event of service.stream("reasoning-v1", request)) { /* consume */ }

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: request.customerId, sessionId: request.sessionId,
      sourceEventId: expect.stringMatching(/^reasoning:[a-f0-9]{64}$/),
      providerId: "neutral-reasoning", adapterKey: "reasoning-v1", measurementStatus: "measured",
      usageDimensions: { "input-tokens": 5, "output-tokens": 2, "total-tokens": 7 },
    }));
  });

  it("records incomplete evidence when a terminal provider response has no final usage", async () => {
    const provider = new ScriptedReasoningProvider([[{ type: "response.completed" }]]);
    const record = jest.fn().mockResolvedValue({});
    const service = new ReasoningPipelineService(registry(provider) as never, { execute: jest.fn() } as never, { record } as never);
    for await (const _event of service.stream("reasoning-v1", request)) { /* consume */ }

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: expect.stringMatching(/^reasoning:[a-f0-9]{64}$/),
      measurementStatus: "incomplete", usageDimensions: {},
    }));
  });
});

function registry(provider: ScriptedReasoningProvider) {
  return { resolve: () => ({ implementation: provider, manifest: { providerId: "neutral-reasoning" } }) };
}
