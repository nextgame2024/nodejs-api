import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { TavusFullProvider } from "./tavus-full.provider.js";

describe("TavusFullProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.TAVUS_API_KEY = "tavus-key";
    process.env.TAVUS_PERSONA_ID = "persona-1";
    process.env.TAVUS_REPLICA_ID = "replica-1";
    process.env.TAVUS_NATIVE_LLM_ONLY = "true";
    process.env.TAVUS_INTERNET_SEARCH_ENABLED = "true";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TAVUS_API_KEY;
    delete process.env.TAVUS_PERSONA_ID;
    delete process.env.TAVUS_REPLICA_ID;
    delete process.env.TAVUS_NATIVE_LLM_ONLY;
    delete process.env.TAVUS_INTERNET_SEARCH_ENABLED;
  });

  it("creates an authenticated Tavus Full conversation", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversation_id: "conversation-1",
          conversation_url: "https://tavus.daily.co/conversation-1",
          meeting_token: "meeting-token",
        }),
      } as Response);
    global.fetch = fetchMock;

    const session = await new TavusFullProvider().createSession({
      customerId: "customer-1",
      storeId: "store-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://tavusapi.com/v2/pals/persona-1/skills/internet_search",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tavusapi.com/v2/conversations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "tavus-key" }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      persona_id: "persona-1",
      replica_id: "replica-1",
      require_auth: true,
      max_participants: 2,
      properties: { language: "multilingual" },
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
        .conversational_context,
    ).toContain("Sophia AI is a configurable, real-time digital assistant");
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
        .conversational_context,
    ).toContain("call showStudentVisaDemoGuidance");
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
        .conversational_context,
    ).toContain("48 hours per fortnight");
    expect(session).toMatchObject({
      provider: "tavus-full",
      providerSessionId: "conversation-1",
      model: "tavus-gpt-oss",
      meetingToken: "meeting-token",
    });
  });

  it("continues conversation creation when optional persona setup fails", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Feature unavailable on this plan",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversation_id: "conversation-2",
          conversation_url: "https://tavus.daily.co/conversation-2",
          meeting_token: "meeting-token-2",
        }),
      } as Response);
    global.fetch = fetchMock;

    await expect(
      new TavusFullProvider().createSession({ customerId: "customer-1" }),
    ).resolves.toMatchObject({ providerSessionId: "conversation-2" });
  });

  it("does not return a Premium session when required runtime tools cannot be configured", async () => {
    process.env.TAVUS_INTERNET_SEARCH_ENABLED = "false";
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "tool service unavailable",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversation_id: "conversation-without-tools",
          conversation_url: "https://tavus.daily.co/conversation-without-tools",
          meeting_token: "meeting-token",
        }),
      } as Response);
    global.fetch = fetchMock;

    await expect(
      new TavusFullProvider().createSession({
        customerId: "customer-1",
        tools: [{ name: "requiredTool", description: "Required", parameters: { type: "object" } }],
      }),
    ).rejects.toThrow("Tavus tool listing failed");
  });

  it("updates existing Tavus tools concurrently to reduce cold-start latency", async () => {
    const definitions = Array.from({ length: 8 }, (_, index) => ({
      name: `tool${index}`,
      description: `Tool ${index}`,
      parameters: { type: "object" },
    }));
    let activeUpdates = 0;
    let peakUpdates = 0;
    const fetchMock = jest.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v2/tools?limit=100")) {
        return {
          ok: true,
          json: async () => ({ data: definitions.map((definition, index) => ({ name: definition.name, tool_id: `id${index}` })) }),
        } as Response;
      }
      if (init?.method === "PATCH") {
        activeUpdates++;
        peakUpdates = Math.max(peakUpdates, activeUpdates);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeUpdates--;
        return { ok: true } as Response;
      }
      if (url.endsWith("/v2/pals/persona-1/tools") && !init?.method) {
        return {
          ok: true,
          json: async () => ({ data: definitions.map((_, index) => ({ tool_id: `id${index}` })) }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    global.fetch = fetchMock;

    await (new TavusFullProvider() as any).ensureRuntimeTools(
      "https://tavusapi.com",
      "tavus-key",
      "persona-1",
      definitions,
    );

    expect(peakUpdates).toBe(6);
  });

  it("returns the Tavus response detail when conversation creation fails", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Conversation limit reached",
      } as Response);
    global.fetch = fetchMock;

    await expect(
      new TavusFullProvider().createSession({ customerId: "customer-1" }),
    ).rejects.toThrow("Conversation limit reached");
  });

  it("ends the Tavus conversation when Sophia finishes", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      text: async () => "",
    } as Response);
    global.fetch = fetchMock;

    await new TavusFullProvider().closeSession("conversation/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://tavusapi.com/v2/conversations/conversation%2F1/end",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

it('avoids a second generated answer for presentation-only tools',()=>{
 const provider=new TavusFullProvider() as any;
 expect(provider.tavusToolPayload({name:'closeStudentView',parameters:{}})).toMatchObject({on_call:'silent',on_resolve:'add_to_context'});
 expect(provider.tavusToolPayload({name:'compareStudentRules',parameters:{}})).toMatchObject({on_call:'silent',on_resolve:'generate_response'});
});
