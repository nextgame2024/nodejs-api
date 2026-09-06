import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { runtimeConfig } from "../../config/runtime-config.js";
import { sophiaConversationInstructions } from "../../knowledge/sophia-profile.js";
import type {
  AIProvider,
  AIProviderMessage,
  AIProviderSession,
  AIProviderSessionRequest,
} from "./ai-provider.interface.js";

export const AI_PROVIDER = Symbol("AI_PROVIDER");

type OpenAIRealtimeClientSecretResponse = {
  value?: string;
  expires_at?: number;
  session?: {
    id?: string;
    model?: string;
  };
  client_secret?: {
    value?: string;
    expires_at?: number;
  };
};

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
        outputModality: request.outputModality,
      };
    }

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.openAi.apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          expires_after: {
            anchor: "created_at",
            seconds: config.openAi.clientSecretTtlSeconds,
          },
          session: {
            type: "realtime",
            model: request.model,
            instructions: sophiaConversationInstructions(),
            output_modalities: [request.outputModality],
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  threshold: config.openAi.vadThreshold,
                  prefix_padding_ms: config.openAi.vadPrefixPaddingMs,
                  silence_duration_ms: config.openAi.vadSilenceDurationMs,
                  create_response: true,
                  interrupt_response: true,
                },
              },
              ...(request.outputModality === "audio"
                ? {
                    output: {
                      format: {
                        type: "audio/pcm",
                        rate: 24_000,
                      },
                      voice: request.voice || config.openAi.voice,
                    },
                  }
                : {}),
            },
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            tool_choice: "auto",
          },
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `OpenAI Realtime client secret request failed: ${response.status} ${detail}`,
      );
    }

    const payload =
      (await response.json()) as OpenAIRealtimeClientSecretResponse;
    const clientSecret = payload.value || payload.client_secret?.value;
    if (!clientSecret) {
      throw new Error("OpenAI Realtime client secret response did not include a token.");
    }

    return {
      provider: "openai-realtime",
      providerSessionId: payload.session?.id || `openai-${randomUUID()}`,
      clientSecret,
      model: payload.session?.model || request.model,
      voice: request.voice,
      outputModality: request.outputModality,
      expiresAt: toIsoTimestamp(payload.expires_at || payload.client_secret?.expires_at),
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

function toIsoTimestamp(value: number | undefined): string | undefined {
  if (!value) return undefined;
  return new Date(value * 1000).toISOString();
}
