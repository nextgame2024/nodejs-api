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
      outputModality: "audio",
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
    process.env.OPENAI_REALTIME_VAD_THRESHOLD = "0.75";
    process.env.OPENAI_REALTIME_VAD_PREFIX_PADDING_MS = "300";
    process.env.OPENAI_REALTIME_VAD_SILENCE_DURATION_MS = "900";
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
      outputModality: "audio",
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
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              threshold: 0.75,
              prefix_padding_ms: 300,
              silence_duration_ms: 900,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            voice: "marin",
          },
        },
        tools: [expect.objectContaining({ name: "getInventory" })],
      },
    });
    expect(session).toMatchObject({
      provider: "openai-realtime",
      providerSessionId: "sess_test",
      clientSecret: "ek_test",
      model: "gpt-realtime-2.1-mini",
      voice: "marin",
      outputModality: "audio",
    });
  });

  it("creates text-only output sessions without OpenAI output audio", async () => {
    process.env.OPENAI_API_KEY = "test-api-key";
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        value: "ek_text_test",
        session: { id: "sess_text_test", model: "test-model" },
      }),
    } as Response);
    global.fetch = fetchMock;

    const provider = new OpenAIRealtimeProvider();
    await provider.createSession({
      customerId: "customer-1",
      model: "test-model",
      voice: "marin",
      outputModality: "text",
      tools: [],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.session.output_modalities).toEqual(["text"]);
    expect(body.session.audio.input).toBeDefined();
    expect(body.session.audio.output).toBeUndefined();
  });
});
