import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { OpenAIRealtimeProvider } from "./openai-realtime.provider.js";

describe("OpenAIRealtimeProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    global.fetch = originalFetch;
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

  it("creates a Realtime client secret with provider credentials", async () => {
    process.env.OPENAI_API_KEY = "test-api-key";
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-2.1-mini";
    process.env.OPENAI_REALTIME_VOICE = "marin";
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        value: "ek_test",
        expires_at: 1787997600,
        session: {
          id: "sess_test",
          model: "gpt-realtime-2.1-mini",
        },
      }),
    } as Response);
    global.fetch = fetchMock;

    const provider = new OpenAIRealtimeProvider();
    const session = await provider.createSession({
      customerId: "customer-1",
      model: "gpt-realtime-2.1-mini",
      voice: "marin",
      tools: [
        {
          name: "getInventory",
          description: "Inventory",
          parameters: {
            type: "object",
            properties: { productId: { type: "string" } },
            required: ["productId"],
          },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-api-key",
          "content-type": "application/json",
        }),
      }),
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1-mini",
        audio: { output: { voice: "marin" } },
        tools: [expect.objectContaining({ name: "getInventory" })],
      },
    });
    expect(session).toMatchObject({
      provider: "openai-realtime",
      providerSessionId: "sess_test",
      clientSecret: "ek_test",
      model: "gpt-realtime-2.1-mini",
      voice: "marin",
    });
  });
});
