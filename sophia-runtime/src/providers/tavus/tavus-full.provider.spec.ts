import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { TavusFullProvider, TavusPartialSessionError } from "./tavus-full.provider.js";

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
      "https://tavusapi.com/v2/conversations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "tavus-key" }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      persona_id: "persona-1",
      replica_id: "replica-1",
      require_auth: true,
      max_participants: 2,
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
        .conversational_context,
    ).toContain("Sophia AI is a configurable, real-time digital assistant");
    expect(session).toMatchObject({
      provider: "tavus-full",
      providerSessionId: "conversation-1",
      model: "tavus-gpt-oss",
      meetingToken: "meeting-token",
    });
  });

  it("never mutates skills or remote tool definitions during session creation", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
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
      new TavusFullProvider().createSession({ customerId: "customer-1", tools: [{ name: "getInventory", description: "Inventory", parameters: {} }] }),
    ).resolves.toMatchObject({ providerSessionId: "conversation-2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://tavusapi.com/v2/conversations");
  });

  it("returns the Tavus response detail when conversation creation fails", async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
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

  it("provisions version-owned tools only through the explicit catalog operation", async () => {
    const allocated = jest.fn().mockResolvedValue(undefined);
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce({ ok: true, text: async () => "" } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ tool_id: "tool-1" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => "" } as Response);
    global.fetch = fetchMock;

    await expect(new TavusFullProvider().provisionCatalog({
      personaId: "persona-1",
      definitions: [{ name: "getInventory", description: "Inventory", parameters: {} }],
      onToolAllocated: allocated,
    })).resolves.toMatchObject({ toolIds: { getInventory: "tool-1" } });

    expect(allocated).toHaveBeenCalledWith("getInventory", "tool-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tavusapi.com/v2/pals/persona-1/skills/internet_search",
      expect.objectContaining({ method: "PUT" }),
    );
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

  it("reports an incomplete remote conversation when immediate compensation fails", async () => {
    const fetchMock = jest.fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ conversation_id: "orphan-conversation" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false, status: 503, text: async () => "cleanup unavailable",
      } as Response);
    global.fetch = fetchMock;

    const failure = await new TavusFullProvider().createSession({ customerId: "customer-1" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TavusPartialSessionError);
    expect((failure as TavusPartialSessionError).conversationId).toBe("orphan-conversation");
  });
});
