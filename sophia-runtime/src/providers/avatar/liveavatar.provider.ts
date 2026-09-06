import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import type {
  AvatarProvider,
  AvatarProviderSession,
  AvatarProviderSessionRequest,
} from "./avatar-provider.interface.js";

const LIVEAVATAR_SANDBOX_AVATAR_ID =
  "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

type LiveAvatarTokenResponse = {
  data?: {
    session_id?: string;
    session_token?: string;
  };
  message?: string;
};

@Injectable()
export class LiveAvatarProvider implements AvatarProvider {
  readonly providerName = "liveavatar" as const;

  async createAvatarSession(
    request: AvatarProviderSessionRequest,
  ): Promise<AvatarProviderSession> {
    const config = runtimeConfig();
    const mode = request.mode || config.liveAvatar.mode;

    if (!config.liveAvatar.apiKey) {
      return {
        provider: this.providerName,
        avatarSessionId: `mock-liveavatar-${randomUUID()}`,
      };
    }

    const avatarId = config.liveAvatar.sandbox
      ? LIVEAVATAR_SANDBOX_AVATAR_ID
      : request.avatarId || config.liveAvatar.avatarId;
    if (!avatarId) {
      throw new Error(
        "LIVEAVATAR_AVATAR_ID is required when sandbox mode is disabled.",
      );
    }
    if (mode === "FULL" && !config.liveAvatar.voiceId) {
      throw new Error(
        "LIVEAVATAR_VOICE_ID is required for LiveAvatar FULL mode.",
      );
    }

    const maxSessionDuration = config.liveAvatar.sandbox
      ? Math.min(config.liveAvatar.maxSessionDurationSeconds, 60)
      : config.liveAvatar.maxSessionDurationSeconds;

    const response = await fetch(
      `${config.liveAvatar.apiBaseUrl}/v1/sessions/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.liveAvatar.apiKey,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          mode,
          avatar_id: avatarId,
          is_sandbox: config.liveAvatar.sandbox,
          max_session_duration: maxSessionDuration,
          ...(mode === "FULL"
            ? {
                avatar_persona: {
                  voice_id: config.liveAvatar.voiceId,
                  language: "en",
                },
              }
            : {}),
          video_settings: {
            quality: "high",
            encoding: "H264",
          },
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `LiveAvatar session token request failed: ${response.status} ${detail}`,
      );
    }

    const payload = (await response.json()) as LiveAvatarTokenResponse;
    const sessionToken = payload.data?.session_token;
    if (!sessionToken) {
      throw new Error(
        payload.message ||
          "LiveAvatar session token response did not include session_token.",
      );
    }

    return {
      provider: this.providerName,
      avatarSessionId:
        payload.data?.session_id || `liveavatar-${randomUUID()}`,
      sessionToken,
      transportMode: "livekit",
      mode,
    };
  }

  async sendAudioChunk(
    _sessionId: string,
    _audioChunk: Buffer,
  ): Promise<void> {
    return;
  }

  async getVideoStream(_sessionId: string): Promise<{ streamUrl?: string }> {
    return {};
  }

  async closeAvatarSession(_sessionId: string): Promise<void> {
    // The browser SDK owns the token-authenticated LiveAvatar media session.
    return;
  }
}
