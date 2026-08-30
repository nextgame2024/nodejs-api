import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { SimliAvatarProvider } from "./simli-avatar.provider.js";

describe("SimliAvatarProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    delete process.env.SIMLI_API_KEY;
    delete process.env.SIMLI_AVATAR_ID;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("creates a provider-neutral mock avatar session without real credentials", async () => {
    const provider = new SimliAvatarProvider();

    const session = await provider.createAvatarSession({
      customerId: "customer-1",
      avatarId: "avatar-1",
    });

    expect(session.provider).toBe("simli");
    expect(session.avatarSessionId).toContain("mock-simli-");
  });

  it("creates a Simli session token with provider credentials", async () => {
    process.env.SIMLI_API_KEY = "test-simli-key";
    process.env.SIMLI_AVATAR_ID = "face-1";
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ session_token: "simli-session-token" }),
    } as Response);
    global.fetch = fetchMock;

    const provider = new SimliAvatarProvider();
    const session = await provider.createAvatarSession({
      customerId: "customer-1",
      avatarId: "face-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.simli.ai/compose/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-simli-api-key": "test-simli-key",
        }),
      }),
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      faceId: "face-1",
      apiVersion: "v2",
      handleSilence: false,
      audioInputFormat: "pcm16",
    });
    expect(session).toMatchObject({
      provider: "simli",
      sessionToken: "simli-session-token",
      transportMode: "livekit",
    });
  });
});
