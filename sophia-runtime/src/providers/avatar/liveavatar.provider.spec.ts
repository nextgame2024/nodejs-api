import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { LiveAvatarProvider } from "./liveavatar.provider.js";

describe("LiveAvatarProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    delete process.env.LIVEAVATAR_API_KEY;
    delete process.env.LIVEAVATAR_AVATAR_ID;
    delete process.env.LIVEAVATAR_MODE;
    delete process.env.LIVEAVATAR_SANDBOX;
    delete process.env.LIVEAVATAR_VOICE_ID;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LIVEAVATAR_API_KEY;
    delete process.env.LIVEAVATAR_AVATAR_ID;
    delete process.env.LIVEAVATAR_MODE;
    delete process.env.LIVEAVATAR_SANDBOX;
    delete process.env.LIVEAVATAR_VOICE_ID;
  });

  it("creates a provider-neutral mock session without credentials", async () => {
    const provider = new LiveAvatarProvider();
    const session = await provider.createAvatarSession({
      customerId: "customer-1",
      mode: "FULL",
    });

    expect(session.provider).toBe("liveavatar");
    expect(session.avatarSessionId).toContain("mock-liveavatar-");
  });

  it("creates LITE sessions without a voice persona", async () => {
    process.env.LIVEAVATAR_API_KEY = "test-liveavatar-key";
    process.env.LIVEAVATAR_SANDBOX = "true";
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          session_id: "liveavatar-lite-session",
          session_token: "liveavatar-lite-token",
        },
      }),
    } as Response);
    global.fetch = fetchMock;

    const provider = new LiveAvatarProvider();
    const session = await provider.createAvatarSession({
      customerId: "customer-1",
      mode: "LITE",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.mode).toBe("LITE");
    expect(body.avatar_persona).toBeUndefined();
    expect(session.mode).toBe("LITE");
  });

  it("creates a sandbox FULL session token with a voice", async () => {
    process.env.LIVEAVATAR_API_KEY = "test-liveavatar-key";
    process.env.LIVEAVATAR_MODE = "FULL";
    process.env.LIVEAVATAR_SANDBOX = "true";
    process.env.LIVEAVATAR_AVATAR_ID = "production-avatar-must-be-ignored";
    process.env.LIVEAVATAR_VOICE_ID = "test-voice-id";
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
      mode: "FULL",
      avatar_id: "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a",
      is_sandbox: true,
      max_session_duration: 60,
      avatar_persona: { voice_id: "test-voice-id", language: "en" },
      video_settings: { quality: "high", encoding: "H264" },
    });
    expect(session).toMatchObject({
      provider: "liveavatar",
      avatarSessionId: "liveavatar-session-1",
      sessionToken: "liveavatar-session-token",
      transportMode: "livekit",
    });
  });

  it("rejects FULL mode without a voice ID", async () => {
    process.env.LIVEAVATAR_API_KEY = "test-liveavatar-key";
    process.env.LIVEAVATAR_MODE = "FULL";

    const provider = new LiveAvatarProvider();

    await expect(
      provider.createAvatarSession({ customerId: "customer-1" }),
    ).rejects.toThrow(
      "LIVEAVATAR_VOICE_ID is required for LiveAvatar FULL mode.",
    );
  });
});
