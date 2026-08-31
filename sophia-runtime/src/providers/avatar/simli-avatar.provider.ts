import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import type {
  AvatarProvider,
  AvatarProviderSession,
  AvatarProviderSessionRequest,
} from "./avatar-provider.interface.js";

type SimliTokenResponse = {
  session_token?: string;
  detail?: unknown;
};

@Injectable()
export class SimliAvatarProvider implements AvatarProvider {
  readonly providerName = "simli" as const;

  async createAvatarSession(
    request: AvatarProviderSessionRequest,
  ): Promise<AvatarProviderSession> {
    const config = runtimeConfig();

    if (!config.simli.apiKey) {
      return {
        provider: "simli",
        avatarSessionId: `mock-simli-${randomUUID()}`,
        transportMode: config.simli.transportMode,
      };
    }

    if (!request.avatarId) {
      throw new Error("SIMLI_AVATAR_ID is required when SIMLI_API_KEY is configured.");
    }

    const response = await fetch("https://api.simli.ai/compose/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-simli-api-key": config.simli.apiKey,
      },
      body: JSON.stringify({
        faceId: request.avatarId,
        apiVersion: "v2",
        handleSilence: false,
        maxSessionLength: config.simli.maxSessionLengthSeconds,
        maxIdleTime: config.simli.maxIdleTimeSeconds,
        startFrame: 0,
        audioInputFormat: "pcm16",
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Simli session token request failed: ${response.status} ${detail}`,
      );
    }

    const payload = (await response.json()) as SimliTokenResponse;
    if (!payload.session_token) {
      throw new Error("Simli session token response did not include session_token.");
    }

    return {
      provider: "simli",
      avatarSessionId: `simli-${randomUUID()}`,
      sessionToken: payload.session_token,
      transportMode: config.simli.transportMode,
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
    return;
  }
}
