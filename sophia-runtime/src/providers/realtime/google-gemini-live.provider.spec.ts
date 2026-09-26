import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { GoogleGeminiLiveProvider } from "./google-gemini-live.provider.js";

describe("GoogleGeminiLiveProvider", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.GEMINI_API_BASE_URL = "https://gemini.example/v1beta";
    process.env.GEMINI_LIVE_MODEL = "gemini-3.8-live";
    process.env.GEMINI_LIVE_TOKEN_TTL_SECONDS = "600";
    process.env.GEMINI_LIVE_NEW_SESSION_TTL_SECONDS = "60";
  });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.GEMINI_API_KEY; });

  it("mints a one-use token constrained to audio, server instructions and blocking aliased tools", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ name: "ephemeral-token" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const result = await new GoogleGeminiLiveProvider().createSession({
      customerId: "customer-1", model: "gemini-3.8-live", outputModality: "audio", voice: "Aoede",
      instructions: "Use only approved tools.", tools: [{ name: "catalog.search", description: "Search", parameters: { type: "object" } }],
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://gemini.example/v1beta/auth_tokens");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": "test-gemini-key" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ uses: 1, liveConnectConstraints: {
      model: "models/gemini-3.8-live", config: {
        responseModalities: ["AUDIO"],
        systemInstruction: { parts: [{ text: "Use only approved tools." }] },
        tools: [{ functionDeclarations: [{ name: "sophia_0_catalog_search", behavior: "BLOCKING" }] }],
        realtimeInputConfig: { activityHandling: "START_OF_ACTIVITY_INTERRUPTS" },
        contextWindowCompression: { slidingWindow: {} },
        inputAudioTranscription: {}, outputAudioTranscription: {},
      },
    } });
    expect(result.clientSecret).toBe("ephemeral-token");
    expect(result.transportBootstrap).toMatchObject({
      protocol: "gemini-live-websocket", inputAudioFormat: "pcm-s16le-16000-mono",
      outputAudioFormat: "pcm-s16le-24000-mono", toolAliases: { sophia_0_catalog_search: "catalog.search" },
    });
    expect(JSON.stringify(result)).not.toContain("test-gemini-key");
  });

  it("fails closed before network I/O for missing credentials, model drift or unsupported text output", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch");
    delete process.env.GEMINI_API_KEY;
    await expect(new GoogleGeminiLiveProvider().createSession(request())).rejects.toThrow("GEMINI_API_KEY");
    process.env.GEMINI_API_KEY = "key";
    await expect(new GoogleGeminiLiveProvider().createSession({ ...request(), model: "other" })).rejects.toThrow("server-approved model");
    await expect(new GoogleGeminiLiveProvider().createSession({ ...request(), outputModality: "text" })).rejects.toThrow("audio output");
    await expect(new GoogleGeminiLiveProvider().createSession({ ...request(), tools: [{ name: "unsafe",
      description: "Unsafe", parameters: { type: "string", pattern: "secret" } }] }))
      .rejects.toThrow("unsupported JSON Schema keyword");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function request() {
  return { customerId: "customer-1", model: "gemini-3.8-live", outputModality: "audio" as const,
    instructions: "Safe.", tools: [] };
}
