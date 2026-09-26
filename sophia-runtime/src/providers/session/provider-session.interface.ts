import type { SessionPlan } from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";
import type { RuntimeToolDefinition } from "../../tools/tool-registry.js";

export type PublicExperience = "essential" | "professional" | "premium";

export type ProviderSessionOpenRequest = {
  experience: string;
  plan?: SessionPlan;
  customerId: string;
  deviceId?: string;
  storeId?: string;
  tools: RuntimeToolDefinition[];
  instructions?: string;
};

export type ProviderSessionOpenResult = {
  persistence: {
    aiProvider: string;
    avatarProvider: string;
    providerSessionId: string;
    avatarSessionId?: string;
    metadata: Record<string, unknown>;
  };
  ai: {
    provider: string;
    model: string;
    voice?: string;
    outputModality: "audio" | "text";
    clientSecret?: string;
    expiresAt?: string;
    transportBootstrap?: Record<string, unknown>;
  };
  avatar: {
    provider: string;
    sessionToken?: string;
    transportMode?: "livekit" | "p2p";
    mode?: "LITE" | "FULL";
    streamUrl?: string;
    expiresAt?: string;
    error?: string;
  };
  tools: RuntimeToolDefinition[];
};

export type StoredProviderSession = {
  providerSessionId?: string;
  avatarSessionId?: string;
  aiProvider: string;
  avatarProvider: string;
  metadata: Record<string, unknown>;
};

export interface ProviderSessionAdapter {
  readonly adapterKey: string;
  readonly providerAdapterKeys: readonly string[];
  readonly experiences: readonly PublicExperience[];
  open(request: ProviderSessionOpenRequest): Promise<ProviderSessionOpenResult>;
  close(session: StoredProviderSession): Promise<void>;
}

export class ProviderPartialOpenError extends Error {
  constructor(
    message: string,
    readonly recoverableSession: StoredProviderSession,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderPartialOpenError";
  }
}
