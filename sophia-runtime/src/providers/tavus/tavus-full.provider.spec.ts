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
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TAVUS_API_KEY;
    delete process.env.TAVUS_PERSONA_ID;
    delete process.env.TAVUS_REPLICA_ID;
    delete process.env.TAVUS_NATIVE_LLM_ONLY;
  });

  it("creates an authenticated Tavus Full conversation", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
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
    expect(session).toMatchObject({
      provider: "tavus-full",
      providerSessionId: "conversation-1",
      model: "tavus-gpt-oss",
      meetingToken: "meeting-token",
    });
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
