import { Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { ProviderCapabilityRegistry } from "../capability/provider-capability.registry.js";
import type { NativeRealtimeProvider } from "../realtime/native-realtime-provider.interface.js";
import type { ProviderSessionAdapter, ProviderSessionOpenRequest, ProviderSessionOpenResult, StoredProviderSession } from "./provider-session.interface.js";

@Injectable()
export class GeminiLiveSessionAdapter implements ProviderSessionAdapter {
  readonly adapterKey = "gemini-live-experience-v1";
  readonly providerAdapterKeys = ["gemini-live-v1"] as const;
  readonly experiences = [] as const;

  constructor(@Inject(ProviderCapabilityRegistry) private readonly providers: ProviderCapabilityRegistry) {}

  async open(request: ProviderSessionOpenRequest): Promise<ProviderSessionOpenResult> {
    const provider = this.providers.resolve<NativeRealtimeProvider>("gemini-live-v1", "native-realtime").implementation;
    const config = runtimeConfig().googleGemini;
    const session = await provider.createSession({
      customerId: request.customerId, deviceId: request.deviceId, storeId: request.storeId,
      model: config.liveModel, outputModality: "audio", tools: request.tools,
      instructions: request.instructions, voice: "Aoede",
    });
    return {
      persistence: { aiProvider: session.provider, avatarProvider: "none", providerSessionId: session.providerSessionId,
        metadata: { lifecycleAdapterKey: this.adapterKey, reasoningAdapterKey: "gemini-live-v1", model: session.model,
          outputModality: session.outputModality, experience: request.experience } },
      ai: { provider: session.provider, model: session.model, voice: session.voice, outputModality: session.outputModality,
        clientSecret: session.clientSecret, expiresAt: session.expiresAt, transportBootstrap: session.transportBootstrap },
      avatar: { provider: "none" },
      tools: request.tools,
    };
  }

  async close(session: StoredProviderSession): Promise<void> {
    if (!session.providerSessionId) return;
    await this.providers.resolve<NativeRealtimeProvider>("gemini-live-v1", "native-realtime")
      .implementation.closeSession(session.providerSessionId);
  }
}
