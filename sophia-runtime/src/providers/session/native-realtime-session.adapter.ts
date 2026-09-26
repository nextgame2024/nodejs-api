import { Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import type { AIProvider } from "../ai/ai-provider.interface.js";
import type { AvatarProvider, AvatarProviderSession } from "../avatar/avatar-provider.interface.js";
import { ProviderCapabilityRegistry } from "../capability/provider-capability.registry.js";
import type {
  ProviderSessionAdapter,
  ProviderSessionOpenRequest,
  ProviderSessionOpenResult,
  StoredProviderSession,
} from "./provider-session.interface.js";
import { ProviderPartialOpenError } from "./provider-session.interface.js";

@Injectable()
export class NativeRealtimeSessionAdapter implements ProviderSessionAdapter {
  readonly adapterKey = "native-realtime-experience-v1";
  readonly providerAdapterKeys = ["native-realtime-v1"] as const;
  readonly experiences = ["essential", "professional"] as const;

  constructor(@Inject(ProviderCapabilityRegistry) private readonly providers: ProviderCapabilityRegistry) {}

  async open(request: ProviderSessionOpenRequest): Promise<ProviderSessionOpenResult> {
    const config = runtimeConfig();
    const ai = this.providers.resolve<AIProvider>("native-realtime-v1", "native-realtime").implementation;
    const professional = request.plan?.pipelineMode === "orchestrated-voice" || request.experience === "professional";
    const plannedAvatarProvider = professional ? "liveavatar" : "none";
    const avatarMode = professional ? "FULL" as const : undefined;
    const outputModality = professional ? "text" as const : "audio" as const;
    const avatarRegistration = professional
      ? this.providers.resolve<AvatarProvider>("live-avatar-v1", "avatar")
      : undefined;
    const avatarPromise: Promise<{ session: AvatarProviderSession | null; error?: string }> = avatarRegistration
      ? avatarRegistration.implementation.createAvatarSession({
          customerId: request.customerId,
          deviceId: request.deviceId,
          avatarId: config.liveAvatar.avatarId,
          mode: avatarMode,
        }).then((session) => ({ session })).catch((error: unknown) => ({
          session: null,
          error: error instanceof Error ? error.message : "Avatar session could not be created.",
        }))
      : Promise.resolve({ session: null });

    const [aiResult, avatarResult] = await Promise.all([
      ai.createSession({
        customerId: request.customerId,
        deviceId: request.deviceId,
        storeId: request.storeId,
        model: config.openAi.realtimeModel,
        voice: config.openAi.voice,
        outputModality,
        tools: request.tools,
        instructions: request.instructions,
      }).then((session) => ({ session })).catch((error: unknown) => ({ error })),
      avatarPromise,
    ]);
    if (!("session" in aiResult)) {
      if (avatarResult.session && avatarRegistration) {
        try {
          await avatarRegistration.implementation.closeAvatarSession(avatarResult.session.avatarSessionId);
        } catch (cleanupError) {
          throw new ProviderPartialOpenError("Native session creation failed and avatar cleanup must be reconciled.", {
            aiProvider: "openai-realtime",
            avatarProvider: avatarResult.session.provider,
            avatarSessionId: avatarResult.session.avatarSessionId,
            metadata: {
              lifecycleAdapterKey: this.adapterKey,
              avatarAdapterKey: avatarRegistration.adapterKey,
              experience: request.experience,
            },
          }, { cause: cleanupError });
        }
      }
      throw aiResult.error;
    }
    const aiSession = aiResult.session;
    const avatar = avatarResult.session;
    return {
      persistence: {
        aiProvider: aiSession.provider,
        avatarProvider: avatar?.provider ?? plannedAvatarProvider,
        providerSessionId: aiSession.providerSessionId,
        avatarSessionId: avatar?.avatarSessionId,
        metadata: {
          lifecycleAdapterKey: this.adapterKey,
          reasoningAdapterKey: "native-realtime-v1",
          ...(avatarRegistration ? { avatarAdapterKey: avatarRegistration.adapterKey } : {}),
          model: aiSession.model,
          voice: aiSession.voice,
          outputModality: aiSession.outputModality,
          ...(avatarMode ? { avatarMode } : {}),
          ...(avatarResult.error ? { avatarError: avatarResult.error } : {}),
          experience: request.experience,
        },
      },
      ai: {
        provider: aiSession.provider,
        model: aiSession.model,
        voice: aiSession.voice,
        outputModality: aiSession.outputModality,
        clientSecret: aiSession.clientSecret,
        expiresAt: aiSession.expiresAt,
        transportBootstrap: aiSession.transportBootstrap,
      },
      avatar: {
        provider: avatar?.provider ?? plannedAvatarProvider,
        sessionToken: avatar?.sessionToken,
        transportMode: avatar?.transportMode,
        mode: avatar?.mode ?? avatarMode,
        streamUrl: avatar?.streamUrl,
        expiresAt: avatar?.expiresAt,
        error: avatarResult.error,
      },
      tools: request.tools,
    };
  }

  async close(session: StoredProviderSession): Promise<void> {
    const ai = this.providers.resolve<AIProvider>("native-realtime-v1", "native-realtime").implementation;
    const avatarAdapterKey = stringMetadata(session.metadata, "avatarAdapterKey")
      ?? legacyAvatarAdapterKey(session.avatarProvider);
    const operations: Promise<void>[] = [];
    if (session.providerSessionId) operations.push(ai.closeSession(session.providerSessionId));
    if (avatarAdapterKey && session.avatarSessionId) operations.push(
      this.providers.resolve<AvatarProvider>(avatarAdapterKey, "avatar")
        .implementation.closeAvatarSession(session.avatarSessionId),
    );
    const settled = await Promise.allSettled(operations);
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "Provider session cleanup failed.");
  }
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  return typeof metadata[key] === "string" ? metadata[key] : undefined;
}

function legacyAvatarAdapterKey(provider: string): string | undefined {
  if (provider === "liveavatar") return "live-avatar-v1";
  if (provider === "simli") return "simli-avatar-v1";
  return undefined;
}
