import { Module } from "@nestjs/common";
import {
  AI_PROVIDER,
  OpenAIRealtimeProvider,
} from "./ai/openai-realtime.provider.js";
import {
  SimliAvatarProvider,
} from "./avatar/simli-avatar.provider.js";
import { LiveAvatarProvider } from "./avatar/liveavatar.provider.js";
import { AvatarProviderRegistry } from "./avatar/avatar-provider.registry.js";

@Module({
  providers: [
    OpenAIRealtimeProvider,
    SimliAvatarProvider,
    LiveAvatarProvider,
    AvatarProviderRegistry,
    {
      provide: AI_PROVIDER,
      useExisting: OpenAIRealtimeProvider,
    },
  ],
  exports: [AI_PROVIDER, AvatarProviderRegistry],
})
export class ProvidersModule {}
