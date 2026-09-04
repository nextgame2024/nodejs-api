import "dotenv/config";
import type { AvatarProviderSelection } from "../providers/avatar/avatar-provider.interface.js";

export type RuntimeConfig = {
  port: number;
  corsOrigins: string[];
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolSize: number;
  schema: string;
  defaultCustomerId?: string;
  defaultStoreId?: string;
  aiProvider: "openai-realtime";
  avatarProvider: AvatarProviderSelection;
  openAi: {
    apiKey?: string;
    realtimeModel: string;
    researchModel: string;
    researchTimeoutMs: number;
    voice: string;
    clientSecretTtlSeconds: number;
    vadThreshold: number;
    vadPrefixPaddingMs: number;
    vadSilenceDurationMs: number;
  };
  simli: {
    apiKey?: string;
    avatarId?: string;
    maxSessionLengthSeconds: number;
    maxIdleTimeSeconds: number;
    transportMode: "livekit" | "p2p";
  };
  liveAvatar: {
    apiKey?: string;
    apiBaseUrl: string;
    avatarId?: string;
    voiceId?: string;
    mode: "FULL" | "LITE";
    sandbox: boolean;
    maxSessionDurationSeconds: number;
  };
  tavus: {
    apiKey?: string;
    apiBaseUrl: string;
    personaId?: string;
    replicaId?: string;
    nativeLlmOnly: boolean;
    internetSearchEnabled: boolean;
  };
  businessManager: {
    apiUrl: string;
    apiToken?: string;
  };
};

export function runtimeConfig(): RuntimeConfig {
  const databaseUrl = process.env.SOPHIA_RUNTIME_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
  }

  const schema = process.env.SOPHIA_RUNTIME_SCHEMA || "sophia_runtime";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error("SOPHIA_RUNTIME_SCHEMA must be a valid PostgreSQL identifier.");
  }

  return {
    port: Number(process.env.PORT || 3400),
    corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:4200")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    databaseUrl,
    databaseSsl: parseBoolean(process.env.SOPHIA_RUNTIME_DB_SSL, true),
    databasePoolSize: Number(process.env.SOPHIA_RUNTIME_DB_POOL_SIZE || 5),
    schema,
    defaultCustomerId: emptyToUndefined(process.env.SOPHIA_DEFAULT_CUSTOMER_ID),
    defaultStoreId: emptyToUndefined(process.env.SOPHIA_DEFAULT_STORE_ID),
    aiProvider: "openai-realtime",
    avatarProvider: parseAvatarProvider(process.env.AVATAR_PROVIDER),
    openAi: {
      apiKey: emptyToUndefined(process.env.OPENAI_API_KEY),
      realtimeModel:
        process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini",
      researchModel: process.env.OPENAI_RESEARCH_MODEL || "gpt-5.4-mini",
      researchTimeoutMs: clampNumber(
        Number(process.env.OPENAI_RESEARCH_TIMEOUT_MS || 45000),
        3000,
        60000,
      ),
      voice: process.env.OPENAI_REALTIME_VOICE || "marin",
      clientSecretTtlSeconds: clampNumber(
        Number(process.env.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS || 600),
        10,
        7200,
      ),
      vadThreshold: clampNumber(
        Number(process.env.OPENAI_REALTIME_VAD_THRESHOLD || 0.75),
        0,
        1,
      ),
      vadPrefixPaddingMs: clampNumber(
        Number(process.env.OPENAI_REALTIME_VAD_PREFIX_PADDING_MS || 300),
        0,
        5000,
      ),
      vadSilenceDurationMs: clampNumber(
        Number(process.env.OPENAI_REALTIME_VAD_SILENCE_DURATION_MS || 900),
        100,
        5000,
      ),
    },
    simli: {
      apiKey: emptyToUndefined(process.env.SIMLI_API_KEY),
      avatarId: emptyToUndefined(process.env.SIMLI_AVATAR_ID),
      maxSessionLengthSeconds: clampNumber(
        Number(process.env.SIMLI_MAX_SESSION_LENGTH_SECONDS || 600),
        60,
        3600,
      ),
      maxIdleTimeSeconds: clampNumber(
        Number(process.env.SIMLI_MAX_IDLE_TIME_SECONDS || 180),
        30,
        600,
      ),
      transportMode:
        process.env.SIMLI_TRANSPORT_MODE === "p2p" ? "p2p" : "livekit",
    },
    liveAvatar: {
      apiKey: emptyToUndefined(process.env.LIVEAVATAR_API_KEY),
      apiBaseUrl:
        process.env.LIVEAVATAR_API_BASE_URL || "https://api.liveavatar.com",
      avatarId: emptyToUndefined(process.env.LIVEAVATAR_AVATAR_ID),
      voiceId: emptyToUndefined(process.env.LIVEAVATAR_VOICE_ID),
      mode: process.env.LIVEAVATAR_MODE === "LITE" ? "LITE" : "FULL",
      sandbox: parseBoolean(process.env.LIVEAVATAR_SANDBOX, true),
      maxSessionDurationSeconds: clampNumber(
        Number(process.env.LIVEAVATAR_MAX_SESSION_DURATION_SECONDS || 600),
        60,
        3600,
      ),
    },
    tavus: {
      apiKey: emptyToUndefined(process.env.TAVUS_API_KEY),
      apiBaseUrl: process.env.TAVUS_API_BASE_URL || "https://tavusapi.com",
      personaId: emptyToUndefined(process.env.TAVUS_PERSONA_ID),
      replicaId: emptyToUndefined(process.env.TAVUS_REPLICA_ID),
      nativeLlmOnly: parseBoolean(process.env.TAVUS_NATIVE_LLM_ONLY, false),
      internetSearchEnabled: parseBoolean(
        process.env.TAVUS_INTERNET_SEARCH_ENABLED,
        true,
      ),
    },
    businessManager: {
      apiUrl: (process.env.BUSINESS_MANAGER_API_URL || "http://localhost:3300/api").replace(/\/$/, ""),
      apiToken: emptyToUndefined(process.env.BUSINESS_MANAGER_API_TOKEN),
    },
  };
}

function parseAvatarProvider(
  value: string | undefined,
): AvatarProviderSelection {
  if (value === "none" || value === "liveavatar") return value;
  return "simli";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
