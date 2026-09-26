import type { RuntimeToolDefinition } from "../../tools/tool-registry.js";

export type NativeRealtimeSessionRequest = {
  customerId: string;
  deviceId?: string;
  storeId?: string;
  model: string;
  voice?: string;
  outputModality: "audio" | "text";
  tools: RuntimeToolDefinition[];
  instructions?: string;
};

export type NativeRealtimeSession = {
  provider: string;
  providerSessionId: string;
  clientSecret?: string;
  model: string;
  voice?: string;
  outputModality: "audio" | "text";
  expiresAt?: string;
  transportBootstrap?: Record<string, unknown>;
};

/** Provider-owned realtime session/bootstrap boundary; reasoning-only providers do not implement it. */
export interface NativeRealtimeProvider {
  createSession(request: NativeRealtimeSessionRequest): Promise<NativeRealtimeSession>;
  closeSession(sessionId: string): Promise<void>;
}
