import { Module } from "@nestjs/common";
import { OpenAIRealtimeProvider } from "./ai/openai-realtime.provider.js";
import {
  SimliAvatarProvider,
} from "./avatar/simli-avatar.provider.js";
import { LiveAvatarProvider } from "./avatar/liveavatar.provider.js";
import { TavusFullProvider } from "./tavus/tavus-full.provider.js";
import { BusinessResearchService } from "../tools/research/business-research.service.js";
import { existingProviderRegistrations } from "./capability/provider-adapter.registrations.js";
import { PROVIDER_ADAPTER_REGISTRATIONS, ProviderCapabilityRegistry } from "./capability/provider-capability.registry.js";
import { NativeRealtimeSessionAdapter } from "./session/native-realtime-session.adapter.js";
import { CompositeRealtimeSessionAdapter } from "./session/composite-realtime-session.adapter.js";
import { PROVIDER_SESSION_ADAPTERS, ProviderSessionRegistry } from "./session/provider-session.registry.js";
import { ProviderCatalogGate } from "./provisioning/provider-catalog-gate.js";
import { OpenAIResponsesReasoningProvider } from "./reasoning/openai-responses-reasoning.provider.js";
import { AnthropicMessagesReasoningProvider } from "./reasoning/anthropic-messages-reasoning.provider.js";
import { GoogleGeminiInteractionsReasoningProvider } from "./reasoning/google-gemini-interactions-reasoning.provider.js";
import { OpenAIBufferedTranscriptionProvider } from "./speech/openai-buffered-transcription.provider.js";
import { OpenAISpeechSynthesisProvider } from "./speech/openai-speech-synthesis.provider.js";
import { GoogleGeminiLiveProvider } from "./realtime/google-gemini-live.provider.js";
import { GeminiLiveSessionAdapter } from "./session/gemini-live-session.adapter.js";

@Module({
  providers: [
    OpenAIRealtimeProvider,
    OpenAIResponsesReasoningProvider,
    AnthropicMessagesReasoningProvider,
    GoogleGeminiInteractionsReasoningProvider,
    OpenAIBufferedTranscriptionProvider,
    OpenAISpeechSynthesisProvider,
    GoogleGeminiLiveProvider,
    SimliAvatarProvider,
    LiveAvatarProvider,
    TavusFullProvider,
    BusinessResearchService,
    {
      provide: PROVIDER_ADAPTER_REGISTRATIONS,
      inject: [OpenAIRealtimeProvider, OpenAIResponsesReasoningProvider, AnthropicMessagesReasoningProvider, GoogleGeminiInteractionsReasoningProvider, OpenAIBufferedTranscriptionProvider, OpenAISpeechSynthesisProvider, GoogleGeminiLiveProvider, TavusFullProvider, LiveAvatarProvider, SimliAvatarProvider, BusinessResearchService],
      useFactory: (
        nativeRealtime: OpenAIRealtimeProvider,
        openAIReasoning: OpenAIResponsesReasoningProvider,
        anthropicReasoning: AnthropicMessagesReasoningProvider,
        googleGeminiReasoning: GoogleGeminiInteractionsReasoningProvider,
        openAITranscription: OpenAIBufferedTranscriptionProvider,
        openAISynthesis: OpenAISpeechSynthesisProvider,
        googleGeminiLive: GoogleGeminiLiveProvider,
        compositeRealtime: TavusFullProvider,
        liveAvatar: LiveAvatarProvider,
        simliAvatar: SimliAvatarProvider,
        research: BusinessResearchService,
      ) => existingProviderRegistrations({ nativeRealtime, openAIReasoning, anthropicReasoning, googleGeminiReasoning, openAITranscription, openAISynthesis, googleGeminiLive, compositeRealtime, liveAvatar, simliAvatar, research }),
    },
    ProviderCapabilityRegistry,
    ProviderCatalogGate,
    NativeRealtimeSessionAdapter,
    CompositeRealtimeSessionAdapter,
    GeminiLiveSessionAdapter,
    {
      provide: PROVIDER_SESSION_ADAPTERS,
      inject: [NativeRealtimeSessionAdapter, CompositeRealtimeSessionAdapter, GeminiLiveSessionAdapter],
      useFactory: (
        nativeRealtime: NativeRealtimeSessionAdapter,
        compositeRealtime: CompositeRealtimeSessionAdapter,
        geminiLive: GeminiLiveSessionAdapter,
      ) => [nativeRealtime, compositeRealtime, geminiLive],
    },
    ProviderSessionRegistry,
  ],
  exports: [ProviderCapabilityRegistry, ProviderSessionRegistry, ProviderCatalogGate,
    OpenAIResponsesReasoningProvider, AnthropicMessagesReasoningProvider, GoogleGeminiInteractionsReasoningProvider,
    OpenAIBufferedTranscriptionProvider, OpenAISpeechSynthesisProvider, GoogleGeminiLiveProvider],
})
export class ProvidersModule {}
