import type { RuntimeToolDefinition } from "../../tools/tool-registry.js";

export type AIProviderSessionRequest = {
  customerId: string;
  deviceId?: string;
  storeId?: string;
  model: string;
  voice?: string;
  tools: RuntimeToolDefinition[];
};

export type AIProviderSession = {
  provider: string;
  providerSessionId: string;
  clientSecret?: string;
  model: string;
  voice?: string;
  expiresAt?: string;
};

export type AIProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export interface AIProvider {
  createSession(request: AIProviderSessionRequest): Promise<AIProviderSession>;
  sendMessage(sessionId: string, message: AIProviderMessage): Promise<void>;
  registerTools(sessionId: string, tools: RuntimeToolDefinition[]): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
