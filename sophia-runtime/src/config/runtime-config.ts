import "dotenv/config";
import type { AvatarProviderSelection } from "../providers/avatar/avatar-provider.interface.js";

export type RuntimeConfig = {
  port: number;
  corsOrigins: string[];
  databaseUrl: string;
  databaseSsl: boolean;
  databasePoolSize: number;
  databaseRole?: string;
  schema: string;
  defaultCustomerId?: string;
  defaultStoreId?: string;
  defaultDeviceId?: string;
  sessionAccessTtlSeconds: number;
  allowedExperiences: Array<"essential" | "professional" | "premium">;
  maxConcurrentSessions: number;
  maxToolCallsPerMinute: number;
  providerSessionCapacity: Record<string, number>;
  toolAdmissionLimits: {
    classes: { readSearch: number; mutation: number; sensitive: number };
    perTool: Record<string, number>;
  };
  providerOpenTimeoutMs: number;
  providerCloseTimeoutMs: number;
  providerSessionMaxSeconds: number;
  disconnectGraceSeconds: number;
  deploymentEnvironment: string;
  v2CanaryTenantIds: string[];
  v2InstallationKey?: string;
  v2BootstrapTtlSeconds: number;
  enabledBusinessPacks: string[];
  providerCatalogMode: "canonical" | "legacy";
  aiProvider: "openai-realtime";
  avatarProvider: AvatarProviderSelection;
  openAi: {
    apiKey?: string;
    realtimeModel: string;
    reasoningModel: string;
    reasoningTimeoutMs: number;
    reasoningMaximumOutputTokens: number;
    audioApiBaseUrl: string;
    transcriptionModel: string;
    synthesisModel: string;
    synthesisVoice: string;
    speechTimeoutMs: number;
    transcriptionMaximumInputBytes: number;
    synthesisMaximumOutputBytes: number;
    researchModel: string;
    researchTimeoutMs: number;
    voice: string;
    clientSecretTtlSeconds: number;
    vadThreshold: number;
    vadPrefixPaddingMs: number;
    vadSilenceDurationMs: number;
  };
  anthropic: {
    apiKey?: string;
    apiBaseUrl: string;
    model: string;
    timeoutMs: number;
    maximumOutputTokens: number;
  };
  googleGemini: {
    apiKey?: string;
    apiBaseUrl: string;
    model: string;
    timeoutMs: number;
    maximumOutputTokens: number;
    liveModel: string;
    liveTokenTtlSeconds: number;
    liveNewSessionTtlSeconds: number;
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
  knowledgeFiles: {
    bucket?: string;
    region?: string;
    endpoint?: string;
    scannerUrl?: string;
    scannerToken?: string;
    uploadTtlSeconds: number;
    maxUploadBytes: number;
    scanTimeoutMs: number;
  };
  billing: {
    provider: "disabled" | "stripe_sandbox" | "stripe_live";
    providerAccountKey: string;
    liveCheckoutEnabled: boolean;
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;
    stripePortalConfigurationId?: string;
    checkoutSuccessUrl?: string;
    checkoutCancelUrl?: string;
    portalReturnUrl?: string;
    stripePriceMappings: Record<string, string>;
    stripeInitialPriceMappings: Record<string, Record<string, string>>;
    stripeMeteredPriceMappings: Record<string, string>;
    stripeOveragePriceMappings: Record<string, string>;
    stripeMeterBindings: Record<string, string>;
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
  const databaseRole = emptyToUndefined(process.env.SOPHIA_RUNTIME_DATABASE_ROLE) || "sophia_runtime_app";
  if (databaseRole && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseRole)) {
    throw new Error("SOPHIA_RUNTIME_DATABASE_ROLE must be a valid PostgreSQL identifier.");
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
    databaseRole,
    schema,
    defaultCustomerId: emptyToUndefined(process.env.SOPHIA_DEFAULT_CUSTOMER_ID),
    defaultStoreId: emptyToUndefined(process.env.SOPHIA_DEFAULT_STORE_ID),
    defaultDeviceId: emptyToUndefined(process.env.SOPHIA_DEFAULT_DEVICE_ID),
    sessionAccessTtlSeconds: clampNumber(
      Number(process.env.SOPHIA_SESSION_ACCESS_TTL_SECONDS || 600),
      60,
      7200,
    ),
    allowedExperiences: parseAllowedExperiences(
      process.env.SOPHIA_ALLOWED_EXPERIENCES,
    ),
    maxConcurrentSessions: positiveInteger(process.env.SOPHIA_MAX_CONCURRENT_SESSIONS, 10, 100),
    maxToolCallsPerMinute: positiveInteger(process.env.SOPHIA_MAX_TOOL_CALLS_PER_MINUTE, 20, 1000),
    providerSessionCapacity: positiveIntegerMap(process.env.SOPHIA_PROVIDER_SESSION_CAPACITY, "SOPHIA_PROVIDER_SESSION_CAPACITY", 100),
    toolAdmissionLimits: {
      classes: {
        readSearch: positiveInteger(process.env.SOPHIA_TOOL_READ_SEARCH_CALLS_PER_MINUTE,
          positiveInteger(process.env.SOPHIA_MAX_TOOL_CALLS_PER_MINUTE, 20, 1000), 1000),
        mutation: positiveInteger(process.env.SOPHIA_TOOL_MUTATION_CALLS_PER_MINUTE,
          positiveInteger(process.env.SOPHIA_MAX_TOOL_CALLS_PER_MINUTE, 20, 1000), 1000),
        sensitive: positiveInteger(process.env.SOPHIA_TOOL_SENSITIVE_CALLS_PER_MINUTE,
          positiveInteger(process.env.SOPHIA_MAX_TOOL_CALLS_PER_MINUTE, 20, 1000), 1000),
      },
      perTool: positiveIntegerMap(process.env.SOPHIA_TOOL_CALLS_PER_MINUTE_BY_TOOL,
        "SOPHIA_TOOL_CALLS_PER_MINUTE_BY_TOOL", 1000),
    },
    providerOpenTimeoutMs: clampNumber(Number(process.env.SOPHIA_PROVIDER_OPEN_TIMEOUT_MS || 25_000), 1_000, 60_000),
    providerCloseTimeoutMs: clampNumber(Number(process.env.SOPHIA_PROVIDER_CLOSE_TIMEOUT_MS || 20_000), 1_000, 60_000),
    providerSessionMaxSeconds: clampNumber(Number(process.env.SOPHIA_PROVIDER_SESSION_MAX_SECONDS || 7_200), 60, 14_400),
    disconnectGraceSeconds: clampNumber(Number(process.env.SOPHIA_DISCONNECT_GRACE_SECONDS || 120), 15, 900),
    deploymentEnvironment: environmentKey(process.env.SOPHIA_DEPLOYMENT_ENV || "development"),
    v2CanaryTenantIds: uuidList(process.env.SOPHIA_V2_CANARY_TENANT_IDS),
    v2InstallationKey: emptyToUndefined(process.env.SOPHIA_V2_INSTALLATION_KEY),
    v2BootstrapTtlSeconds: clampNumber(Number(process.env.SOPHIA_V2_BOOTSTRAP_TTL_SECONDS || 120), 30, 300),
    enabledBusinessPacks: parseBusinessPacks(process.env.SOPHIA_BUSINESS_PACKS),
    providerCatalogMode: parseCatalogMode(process.env.SOPHIA_PROVIDER_CATALOG_MODE),
    aiProvider: "openai-realtime",
    avatarProvider: parseAvatarProvider(process.env.AVATAR_PROVIDER),
    openAi: {
      apiKey: emptyToUndefined(process.env.OPENAI_API_KEY),
      realtimeModel:
        process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini",
      reasoningModel: process.env.OPENAI_REASONING_MODEL || "gpt-5.4-mini",
      reasoningTimeoutMs: clampNumber(Number(process.env.OPENAI_REASONING_TIMEOUT_MS || 60_000), 3_000, 120_000),
      reasoningMaximumOutputTokens: clampNumber(Number(process.env.OPENAI_REASONING_MAX_OUTPUT_TOKENS || 4_096), 256, 32_768),
      audioApiBaseUrl: process.env.OPENAI_AUDIO_API_BASE_URL || "https://api.openai.com/v1",
      transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-transcribe",
      synthesisModel: process.env.OPENAI_SYNTHESIS_MODEL || "gpt-4o-mini-tts",
      synthesisVoice: process.env.OPENAI_SYNTHESIS_VOICE || "marin",
      speechTimeoutMs: clampNumber(Number(process.env.OPENAI_SPEECH_TIMEOUT_MS || 60_000), 3_000, 120_000),
      transcriptionMaximumInputBytes: clampNumber(Number(process.env.OPENAI_TRANSCRIPTION_MAX_INPUT_BYTES || 2_880_000), 48_000, 25_000_000),
      synthesisMaximumOutputBytes: clampNumber(Number(process.env.OPENAI_SYNTHESIS_MAX_OUTPUT_BYTES || 12_000_000), 48_000, 48_000_000),
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
    anthropic: {
      apiKey: emptyToUndefined(process.env.ANTHROPIC_API_KEY),
      apiBaseUrl: process.env.ANTHROPIC_API_BASE_URL || "https://api.anthropic.com",
      model: process.env.ANTHROPIC_REASONING_MODEL || "claude-sonnet-5",
      timeoutMs: clampNumber(Number(process.env.ANTHROPIC_REASONING_TIMEOUT_MS || 60_000), 3_000, 120_000),
      maximumOutputTokens: clampNumber(Number(process.env.ANTHROPIC_REASONING_MAX_OUTPUT_TOKENS || 4_096), 256, 32_768),
    },
    googleGemini: {
      apiKey: emptyToUndefined(process.env.GEMINI_API_KEY),
      apiBaseUrl: process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
      model: process.env.GEMINI_REASONING_MODEL || "gemini-3.8-flash",
      timeoutMs: clampNumber(Number(process.env.GEMINI_REASONING_TIMEOUT_MS || 60_000), 3_000, 120_000),
      maximumOutputTokens: clampNumber(Number(process.env.GEMINI_REASONING_MAX_OUTPUT_TOKENS || 4_096), 256, 32_768),
      liveModel: process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live",
      liveTokenTtlSeconds: clampNumber(Number(process.env.GEMINI_LIVE_TOKEN_TTL_SECONDS || 600), 300, 900),
      liveNewSessionTtlSeconds: clampNumber(Number(process.env.GEMINI_LIVE_NEW_SESSION_TTL_SECONDS || 60), 30, 300),
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
    knowledgeFiles: {
      bucket: emptyToUndefined(process.env.SOPHIA_KNOWLEDGE_S3_BUCKET),
      region: emptyToUndefined(process.env.SOPHIA_KNOWLEDGE_S3_REGION),
      endpoint: emptyToUndefined(process.env.SOPHIA_KNOWLEDGE_S3_ENDPOINT),
      scannerUrl: emptyToUndefined(process.env.SOPHIA_KNOWLEDGE_SCANNER_URL)?.replace(/\/$/, ""),
      scannerToken: emptyToUndefined(process.env.SOPHIA_KNOWLEDGE_SCANNER_TOKEN),
      uploadTtlSeconds: clampNumber(Number(process.env.SOPHIA_KNOWLEDGE_UPLOAD_TTL_SECONDS || 300), 60, 900),
      maxUploadBytes: clampNumber(Number(process.env.SOPHIA_KNOWLEDGE_MAX_UPLOAD_BYTES || 1_048_576), 65_536, 1_048_576),
      scanTimeoutMs: clampNumber(Number(process.env.SOPHIA_KNOWLEDGE_SCAN_TIMEOUT_MS || 15_000), 1_000, 30_000),
    },
    billing: billingConfig(),
  };
}

function billingConfig(): RuntimeConfig["billing"] {
  const requestedProvider = emptyToUndefined(process.env.SOPHIA_BILLING_PROVIDER);
  if (requestedProvider && !["disabled", "stripe_sandbox", "stripe_live"].includes(requestedProvider)) {
    throw new Error("SOPHIA_BILLING_PROVIDER must be disabled, stripe_sandbox, or stripe_live.");
  }
  const provider = (requestedProvider || "disabled") as RuntimeConfig["billing"]["provider"];
  const providerAccountKey = emptyToUndefined(process.env.SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY) || "legacy-primary";
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(providerAccountKey)) {
    throw new Error("SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY must be a stable lowercase account key.");
  }
  const liveCheckoutEnabled = parseBoolean(process.env.SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED, false);
  const stripeSecretKey = emptyToUndefined(process.env.SOPHIA_BILLING_STRIPE_SECRET_KEY);
  if (stripeSecretKey && !/^sk_(?:test|live)_/.test(stripeSecretKey)) {
    throw new Error("SOPHIA_BILLING_STRIPE_SECRET_KEY must be a Stripe secret key.");
  }
  if (provider === "stripe_sandbox" && stripeSecretKey && !stripeSecretKey.startsWith("sk_test_")) {
    throw new Error("Stripe sandbox mode requires a test-mode secret key.");
  }
  if (provider === "stripe_live" && stripeSecretKey && !stripeSecretKey.startsWith("sk_live_")) {
    throw new Error("Stripe live mode requires a live-mode secret key.");
  }
  if (provider !== "stripe_live" && liveCheckoutEnabled) {
    throw new Error("SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED may only be enabled with stripe_live.");
  }
  const stripeWebhookSecret = emptyToUndefined(process.env.SOPHIA_BILLING_STRIPE_WEBHOOK_SECRET);
  if (stripeWebhookSecret && !stripeWebhookSecret.startsWith("whsec_")) {
    throw new Error("SOPHIA_BILLING_STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret.");
  }
  const stripePortalConfigurationId = emptyToUndefined(process.env.SOPHIA_BILLING_STRIPE_PORTAL_CONFIGURATION_ID);
  if (stripePortalConfigurationId && !/^bpc_[A-Za-z0-9]{8,}$/.test(stripePortalConfigurationId)) {
    throw new Error("SOPHIA_BILLING_STRIPE_PORTAL_CONFIGURATION_ID must be a Stripe portal configuration ID.");
  }
  return {
    provider,
    providerAccountKey,
    liveCheckoutEnabled,
    stripeSecretKey,
    stripeWebhookSecret,
    stripePortalConfigurationId,
    checkoutSuccessUrl: hostedUrl(process.env.SOPHIA_BILLING_CHECKOUT_SUCCESS_URL),
    checkoutCancelUrl: hostedUrl(process.env.SOPHIA_BILLING_CHECKOUT_CANCEL_URL),
    portalReturnUrl: hostedUrl(process.env.SOPHIA_BILLING_PORTAL_RETURN_URL),
    stripePriceMappings: stripePriceMappings(
      process.env.SOPHIA_BILLING_STRIPE_PRICE_MAPPINGS,
      "SOPHIA_BILLING_STRIPE_PRICE_MAPPINGS",
    ),
    stripeInitialPriceMappings: stripeComponentPriceMappings(
      process.env.SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS,
      "SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS",
    ),
    stripeMeteredPriceMappings: stripePriceMappings(
      process.env.SOPHIA_BILLING_STRIPE_METERED_PRICE_MAPPINGS,
      "SOPHIA_BILLING_STRIPE_METERED_PRICE_MAPPINGS",
    ),
    stripeOveragePriceMappings: stripePriceMappings(
      process.env.SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS,
      "SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS",
    ),
    stripeMeterBindings: stripeMeterBindings(process.env.SOPHIA_BILLING_STRIPE_METER_BINDINGS),
  };
}

function hostedUrl(value: string | undefined): string | undefined {
  const candidate = emptyToUndefined(value); if (!candidate) return undefined;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new Error("Sophia billing return URLs must use HTTPS except on localhost.");
  }
  return parsed.toString();
}

function stripePriceMappings(value: string | undefined, variableName: string): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${variableName} must be valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${variableName} must be an object keyed by commercial plan version UUID.`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([id, price]) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      || typeof price !== "string" || !/^price_[A-Za-z0-9]{8,}$/.test(price))) {
    throw new Error("Sophia Stripe mappings must map plan-version UUIDs to Stripe Price IDs.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function stripeComponentPriceMappings(value: string | undefined, variableName: string): Record<string, Record<string, string>> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${variableName} must be valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${variableName} must be an object keyed by commercial plan version UUID.`);
  }
  const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validKey = /^[a-z][a-z0-9-]{1,79}$/;
  const validPrice = /^price_[A-Za-z0-9]{8,}$/;
  for (const [planId, components] of Object.entries(parsed as Record<string, unknown>)) {
    if (!validUuid.test(planId) || !components || typeof components !== "object" || Array.isArray(components)
      || Object.keys(components as object).length === 0
      || Object.entries(components as Record<string, unknown>).some(([key, price]) =>
        !validKey.test(key) || typeof price !== "string" || !validPrice.test(price))) {
      throw new Error(`${variableName} must map plan-version UUIDs and component keys to Stripe Price IDs.`);
    }
  }
  return parsed as Record<string, Record<string, string>>;
}

function stripeMeterBindings(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("SOPHIA_BILLING_STRIPE_METER_BINDINGS must be valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SOPHIA_BILLING_STRIPE_METER_BINDINGS must be an object keyed by internal Meter binding key.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([binding, eventName]) => !/^[a-z][a-z0-9-]{1,79}$/.test(binding)
      || typeof eventName !== "string" || !/^[a-z][a-z0-9_]{1,99}$/.test(eventName))) {
    throw new Error("Sophia Stripe Meter bindings must map stable lowercase binding keys to Stripe event names.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseAllowedExperiences(
  value: string | undefined,
): Array<"essential" | "professional" | "premium"> {
  const supported = new Set(["essential", "professional", "premium"] as const);
  const requested = (value || "essential,professional,premium")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is "essential" | "professional" | "premium" =>
      supported.has(item as "essential" | "professional" | "premium"),
    );
  return [...new Set(requested)];
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

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Sophia admission limits must be whole numbers between 1 and ${maximum}.`);
  }
  return parsed;
}

function positiveIntegerMap(value: string | undefined, name: string, maximum: number): Record<string, number> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object.`);
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([key, limit]) => !/^[a-z][a-z0-9._-]{1,119}$/.test(key)
      || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > maximum)) {
    throw new Error(`${name} must map stable lowercase keys to whole-number limits between 1 and ${maximum}.`);
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

function environmentKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
    throw new Error("SOPHIA_DEPLOYMENT_ENV must be a lowercase environment key.");
  }
  return normalized;
}

function uuidList(value: string | undefined): string[] {
  const values = [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.some((item) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item))) {
    throw new Error("SOPHIA_V2_CANARY_TENANT_IDS must contain only UUIDs.");
  }
  return values;
}

function parseBusinessPacks(value: string | undefined): string[] {
  const requested = (value === undefined ? "real-estate" : value)
    .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (requested.includes("none")) {
    if (requested.length !== 1) throw new Error("SOPHIA_BUSINESS_PACKS=none cannot be combined with pack IDs.");
    return [];
  }
  const allowed = new Set(["real-estate"]);
  if (requested.some((item) => !allowed.has(item))) throw new Error("SOPHIA_BUSINESS_PACKS contains an unregistered pack.");
  return [...new Set(requested)];
}

function parseCatalogMode(value: string | undefined): "canonical" | "legacy" {
  const normalized = (value || "legacy").trim().toLowerCase();
  if (normalized !== "canonical" && normalized !== "legacy") {
    throw new Error("SOPHIA_PROVIDER_CATALOG_MODE must be canonical or legacy.");
  }
  return normalized;
}
