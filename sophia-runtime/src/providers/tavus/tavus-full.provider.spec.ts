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
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
        .conversational_context,
    ).toContain("Sophia AI is a configurable, real-time digital assistant");
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
