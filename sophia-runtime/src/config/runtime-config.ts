import "dotenv/config";

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
  avatarProvider: "simli";
  openAi: {
    apiKey?: string;
    realtimeModel: string;
    voice: string;
    clientSecretTtlSeconds: number;
  };
  simli: {
    apiKey?: string;
    avatarId?: string;
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
    avatarProvider: "simli",
    openAi: {
      apiKey: emptyToUndefined(process.env.OPENAI_API_KEY),
      realtimeModel:
        process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini",
      voice: process.env.OPENAI_REALTIME_VOICE || "marin",
      clientSecretTtlSeconds: clampNumber(
        Number(process.env.OPENAI_REALTIME_CLIENT_SECRET_TTL_SECONDS || 600),
        10,
        7200,
      ),
    },
    simli: {
      apiKey: emptyToUndefined(process.env.SIMLI_API_KEY),
      avatarId: emptyToUndefined(process.env.SIMLI_AVATAR_ID),
    },
  };
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
