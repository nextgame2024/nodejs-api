import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import type {
  AvatarProvider,
  AvatarProviderSession,
  AvatarProviderSessionRequest,
} from "./avatar-provider.interface.js";

export const AVATAR_PROVIDER = Symbol("AVATAR_PROVIDER");

@Injectable()
export class SimliAvatarProvider implements AvatarProvider {
  async createAvatarSession(
    request: AvatarProviderSessionRequest,
  ): Promise<AvatarProviderSession> {
    const config = runtimeConfig();

    if (!config.simli.apiKey) {
      return {
        provider: "simli",
        avatarSessionId: `mock-simli-${randomUUID()}`,
      };
    }

    // Real Simli session creation belongs here only.
    // Angular and core modules stay provider-neutral.
    return {
      provider: "simli",
      avatarSessionId: `simli-${randomUUID()}`,
      streamUrl: undefined,
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
