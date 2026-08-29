import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import type {
  AIProvider,
  AIProviderMessage,
  AIProviderSession,
  AIProviderSessionRequest,
} from "./ai-provider.interface.js";

export const AI_PROVIDER = Symbol("AI_PROVIDER");

@Injectable()
export class OpenAIRealtimeProvider implements AIProvider {
  async createSession(
    request: AIProviderSessionRequest,
  ): Promise<AIProviderSession> {
    const config = runtimeConfig();

    if (!config.openAi.apiKey) {
      return {
        provider: "openai-realtime",
        providerSessionId: `mock-openai-${randomUUID()}`,
        model: request.model,
        voice: request.voice,
      };
    }

    // Real OpenAI Realtime session creation belongs here only.
    // Core conversation modules consume AIProvider and never import OpenAI SDKs.
    return {
      provider: "openai-realtime",
      providerSessionId: `openai-${randomUUID()}`,
      model: request.model,
      voice: request.voice,
    };
  }

  async sendMessage(
    _sessionId: string,
    _message: AIProviderMessage,
  ): Promise<void> {
    return;
  }

  async registerTools(
    _sessionId: string,
    _tools: AIProviderSessionRequest["tools"],
  ): Promise<void> {
    return;
  }

  async closeSession(_sessionId: string): Promise<void> {
    return;
  }
}
