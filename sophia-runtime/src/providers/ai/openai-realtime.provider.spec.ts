import { beforeEach, describe, expect, it } from "@jest/globals";
import { OpenAIRealtimeProvider } from "./openai-realtime.provider.js";

describe("OpenAIRealtimeProvider", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    delete process.env.OPENAI_API_KEY;
  });

  it("creates a provider-neutral mock session without real credentials", async () => {
    const provider = new OpenAIRealtimeProvider();

    const session = await provider.createSession({
      customerId: "customer-1",
      model: "test-model",
      voice: "test-voice",
      tools: [],
    });

    expect(session).toMatchObject({
      provider: "openai-realtime",
      model: "test-model",
      voice: "test-voice",
    });
    expect(session.providerSessionId).toContain("mock-openai-");
  });
});
