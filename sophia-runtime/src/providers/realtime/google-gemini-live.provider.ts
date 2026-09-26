import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import type { RuntimeToolDefinition } from "../../tools/tool-registry.js";
import type { NativeRealtimeProvider, NativeRealtimeSession, NativeRealtimeSessionRequest } from "./native-realtime-provider.interface.js";
import { validateGeminiSchema } from "../reasoning/google-gemini-interactions-reasoning.provider.js";

const GEMINI_LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

type AuthTokenResponse = { name?: unknown };

@Injectable()
export class GoogleGeminiLiveProvider implements NativeRealtimeProvider {
  async createSession(request: NativeRealtimeSessionRequest): Promise<NativeRealtimeSession> {
    const config = runtimeConfig().googleGemini;
    if (!config.apiKey) throw new Error("Gemini Live is unavailable because GEMINI_API_KEY is not configured.");
    if (request.outputModality !== "audio") throw new Error("gemini-3.8-live supports audio output in this adapter.");
    if (request.model !== config.liveModel) throw new Error("The Gemini Live model must match the server-approved model.");
    request.tools.forEach((tool) => validateGeminiSchema(tool.name, tool.parameters));
    const aliases = toolAliases(request.tools);
    const expiresAt = new Date(Date.now() + config.liveTokenTtlSeconds * 1_000);
    const newSessionExpiresAt = new Date(Date.now() + config.liveNewSessionTtlSeconds * 1_000);
    const model = `models/${config.liveModel}`;
    const liveConfig = {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice || "Aoede" } } },
      systemInstruction: { parts: [{ text: boundedInstructions(request.instructions) }] },
      tools: [{ functionDeclarations: request.tools.map((tool) => ({
        name: aliases.providerByCanonical.get(tool.name), description: tool.description,
        parameters: tool.parameters, behavior: "BLOCKING",
      })) }],
      realtimeInputConfig: { activityHandling: "START_OF_ACTIVITY_INTERRUPTS" },
      contextWindowCompression: { slidingWindow: {} },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/auth_tokens`, {
      method: "POST",
      headers: { "x-goog-api-key": config.apiKey, "content-type": "application/json" },
      signal: AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify({
        uses: 1,
        expireTime: expiresAt.toISOString(),
        newSessionExpireTime: newSessionExpiresAt.toISOString(),
        liveConnectConstraints: { model, config: liveConfig },
      }),
    });
    if (!response.ok) throw new Error(`Gemini Live token request failed with status ${response.status}.`);
    const payload = await response.json() as AuthTokenResponse;
    if (typeof payload.name !== "string" || !payload.name) throw new Error("Gemini Live token response did not include a token.");
    return {
      provider: "gemini-live",
      providerSessionId: `gemini-live-${randomUUID()}`,
      clientSecret: payload.name,
      model: config.liveModel,
      voice: request.voice,
      outputModality: "audio",
      expiresAt: expiresAt.toISOString(),
      transportBootstrap: {
        protocol: "gemini-live-websocket",
        endpoint: GEMINI_LIVE_ENDPOINT,
        credentialQueryParameter: "access_token",
        setup: {},
        inputAudioFormat: "pcm-s16le-16000-mono",
        outputAudioFormat: "pcm-s16le-24000-mono",
        toolAliases: Object.fromEntries(aliases.canonicalByProvider),
      },
    };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // The one-use constrained token creates a browser-owned WebSocket session.
  }
}

function toolAliases(tools: readonly RuntimeToolDefinition[]): {
  providerByCanonical: Map<string, string>;
  canonicalByProvider: Map<string, string>;
} {
  const providerByCanonical = new Map<string, string>();
  const canonicalByProvider = new Map<string, string>();
  tools.forEach((tool, index) => {
    const semantic = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
    const alias = `sophia_${index}_${semantic}`.slice(0, 128);
    providerByCanonical.set(tool.name, alias);
    canonicalByProvider.set(alias, tool.name);
  });
  return { providerByCanonical, canonicalByProvider };
}

function boundedInstructions(value: string | undefined): string {
  const instructions = value?.trim();
  if (!instructions) throw new Error("Gemini Live requires server-owned instructions.");
  if (instructions.length > 40_000) throw new Error("Gemini Live instructions exceed 40000 characters.");
  return instructions;
}
