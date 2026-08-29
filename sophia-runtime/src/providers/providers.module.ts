import { Module } from "@nestjs/common";
import {
  AI_PROVIDER,
  OpenAIRealtimeProvider,
} from "./ai/openai-realtime.provider.js";
import {
  AVATAR_PROVIDER,
  SimliAvatarProvider,
} from "./avatar/simli-avatar.provider.js";

@Module({
  providers: [
    OpenAIRealtimeProvider,
    SimliAvatarProvider,
    {
      provide: AI_PROVIDER,
      useExisting: OpenAIRealtimeProvider,
    },
    {
      provide: AVATAR_PROVIDER,
      useExisting: SimliAvatarProvider,
    },
  ],
  exports: [AI_PROVIDER, AVATAR_PROVIDER],
})
export class ProvidersModule {}
