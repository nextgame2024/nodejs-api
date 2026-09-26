import type { RuntimeToolDefinition } from "../../tools/tool-registry.js";
import type { NativeRealtimeProvider, NativeRealtimeSession, NativeRealtimeSessionRequest } from "../realtime/native-realtime-provider.interface.js";

export type AIProviderSessionRequest = NativeRealtimeSessionRequest;

export type AIProviderSession = NativeRealtimeSession;

export type AIProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export interface AIProvider extends NativeRealtimeProvider {
  sendMessage(sessionId: string, message: AIProviderMessage): Promise<void>;
  registerTools(sessionId: string, tools: RuntimeToolDefinition[]): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
