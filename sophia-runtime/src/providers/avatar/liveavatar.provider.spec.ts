import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { LiveAvatarProvider } from "./liveavatar.provider.js";

describe("LiveAvatarProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    delete process.env.LIVEAVATAR_API_KEY;
    delete process.env.LIVEAVATAR_AVATAR_ID;
    delete process.env.LIVEAVATAR_SANDBOX;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LIVEAVATAR_API_KEY;
    delete process.env.LIVEAVATAR_AVATAR_ID;
    delete process.env.LIVEAVATAR_SANDBOX;
  });

  it("creates a provider-neutral mock session without credentials", async () => {
    const provider = new LiveAvatarProvider();
    const session = await provider.createAvatarSession({
      customerId: "customer-1",
    });

    expect(session.provider).toBe("liveavatar");
    expect(session.avatarSessionId).toContain("mock-liveavatar-");
  });

  it("creates a sandbox LITE session token", async () => {
    process.env.LIVEAVATAR_API_KEY = "test-liveavatar-key";
    process.env.LIVEAVATAR_SANDBOX = "true";
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          session_id: "liveavatar-session-1",
          session_token: "liveavatar-session-token",
        },
      }),
    } as Response);
    global.fetch = fetchMock;

    const provider = new LiveAvatarProvider();
    const session = await provider.createAvatarSession({
      customerId: "customer-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.liveavatar.com/v1/sessions/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-api-key": "test-liveavatar-key",
        }),
      }),
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      mode: "LITE",
      avatar_id: "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a",
      is_sandbox: true,
      video_settings: { quality: "high", encoding: "H264" },
    });
    expect(session).toMatchObject({
      provider: "liveavatar",
      avatarSessionId: "liveavatar-session-1",
      sessionToken: "liveavatar-session-token",
      transportMode: "livekit",
    });
  });
});
