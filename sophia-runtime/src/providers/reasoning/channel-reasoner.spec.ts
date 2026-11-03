import { describe, it, expect, jest } from "@jest/globals";
import { generateChannelAnswer } from "./channel-reasoner.js";
import type {
  ReasoningProvider,
  ReasoningProviderEvent,
  OpenReasoningSessionRequest,
  ReasoningProviderInput,
} from "./reasoning-provider.interface.js";
const input = () => ({
  adapterKey: "openai-reasoning-v1",
  credentialRef: "env://openai-reasoning",
  jobId: "job",
  instructions: "Be concise",
  question: "Course price?",
  language: "es",
  sources: [{ id: "source", title: "Approved", content: "Price AUD 100" }],
  signal: new AbortController().signal,
});
function provider(events: ReasoningProviderEvent[]) {
  const close = jest.fn(async () => {});
  const stream = jest.fn(async function* (
    _input: ReasoningProviderInput,
    _signal: AbortSignal,
  ) {
    for (const event of events) yield event;
  });
  const open = jest.fn(async (_request: OpenReasoningSessionRequest) => ({
    stream,
    close,
  }));
  return { implementation: { open } as ReasoningProvider, open, stream, close };
}
describe("Provider-neutral channel answer adapter", () => {
  it("uses the existing reasoning port with no tools/history and separates user/source data from instructions", async () => {
    const p = provider([
      {
        type: "text.delta",
        delta: '{"handoff":false,"answer":"AUD 100","sourceIds":["source"]}',
      },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      },
      { type: "response.completed" },
    ]);
    const result = await generateChannelAnswer(input(), p.implementation);
    expect(result.answer).toBe("AUD 100");
    expect(result.usage).toMatchObject({
      measurementStatus: "measured",
      totalTokens: 20,
    });
    expect(p.open.mock.calls[0][0]).toMatchObject({ tools: [], history: [] });
    expect(p.stream.mock.calls[0][0]).toMatchObject({ type: "user" });
    expect(p.close).toHaveBeenCalledTimes(1);
  });
  it("fails closed on unsupported credential binding without opening a provider", async () => {
    const p = provider([]);
    await expect(
      generateChannelAnswer(
        { ...input(), credentialRef: "secret-other-tenant" },
        p.implementation,
      ),
    ).rejects.toThrow();
    expect(p.open).not.toHaveBeenCalled();
  });
  it("classifies appointment requests without exposing a booking tool or claiming a slot", async () => {
    const p = provider([
      {
        type: "text.delta",
        delta:
          '{"handoff":false,"answer":"","sourceIds":[],"booking":{"action":"availability","date":"2026-11-10"}}',
      },
      { type: "response.completed" },
    ]);
    const result = await generateChannelAnswer(
      {
        ...input(),
        bookingContext: {
          timezone: "Australia/Brisbane",
          today: "2026-11-04",
          maxDate: "2026-12-04",
        },
      },
      p.implementation,
    );
    expect(result).toMatchObject({
      booking: { action: "availability", date: "2026-11-10" },
    });
    expect(p.open.mock.calls[0][0].tools).toEqual([]);
    expect(p.open.mock.calls[0][0].instructions).toContain(
      "Never choose or return an appointment ID",
    );
  });
  it("classifies cancellation and rescheduling without appointment identifiers or tools", async () => {
    for (const [delta, expected] of [
      [
        '{"handoff":false,"answer":"","sourceIds":[],"booking":{"action":"cancel"}}',
        { action: "cancel" },
      ],
      [
        '{"handoff":false,"answer":"","sourceIds":[],"booking":{"action":"reschedule","date":"2026-11-12"}}',
        { action: "reschedule", date: "2026-11-12" },
      ],
    ] as const) {
      const p = provider([
        { type: "text.delta", delta },
        { type: "response.completed" },
      ]);
      const result = await generateChannelAnswer(
        {
          ...input(),
          bookingContext: {
            timezone: "Australia/Brisbane",
            today: "2026-11-04",
            maxDate: "2026-12-04",
          },
        },
        p.implementation,
      );
      expect(result.booking).toEqual(expected);
      expect(p.open.mock.calls[0][0].tools).toEqual([]);
    }
  });
  it("rejects incomplete output, tool calls and malformed JSON, always closing the session", async () => {
    for (const events of [
      [
        { type: "text.delta", delta: "not JSON" },
        { type: "response.completed" },
      ],
      [
        {
          type: "tool.call",
          call: { callId: "c", name: "send", arguments: {} },
        },
      ],
      [{ type: "text.delta", delta: "{}" }],
    ] as ReasoningProviderEvent[][]) {
      const p = provider(events);
      await expect(
        generateChannelAnswer(input(), p.implementation),
      ).rejects.toThrow();
      expect(p.close).toHaveBeenCalledTimes(1);
    }
  });
});
