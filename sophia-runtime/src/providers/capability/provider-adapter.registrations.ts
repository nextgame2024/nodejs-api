import type { ProviderCapabilityManifest } from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";
import type { BusinessResearchService } from "../../tools/research/business-research.service.js";
import type { OpenAIRealtimeProvider } from "../ai/openai-realtime.provider.js";
import type { OpenAIResponsesReasoningProvider } from "../reasoning/openai-responses-reasoning.provider.js";
import type { AnthropicMessagesReasoningProvider } from "../reasoning/anthropic-messages-reasoning.provider.js";
import type { GoogleGeminiInteractionsReasoningProvider } from "../reasoning/google-gemini-interactions-reasoning.provider.js";
import type { LiveAvatarProvider } from "../avatar/liveavatar.provider.js";
import type { SimliAvatarProvider } from "../avatar/simli-avatar.provider.js";
import type { TavusFullProvider } from "../tavus/tavus-full.provider.js";
import type { OpenAIBufferedTranscriptionProvider } from "../speech/openai-buffered-transcription.provider.js";
import type { OpenAISpeechSynthesisProvider } from "../speech/openai-speech-synthesis.provider.js";
import type { GoogleGeminiLiveProvider } from "../realtime/google-gemini-live.provider.js";
import type { ProviderAdapterRegistration } from "./provider-capability.registry.js";

export function existingProviderRegistrations(input: {
  nativeRealtime: OpenAIRealtimeProvider;
  openAIReasoning: OpenAIResponsesReasoningProvider;
  anthropicReasoning: AnthropicMessagesReasoningProvider;
  googleGeminiReasoning: GoogleGeminiInteractionsReasoningProvider;
  openAITranscription: OpenAIBufferedTranscriptionProvider;
  openAISynthesis: OpenAISpeechSynthesisProvider;
  googleGeminiLive: GoogleGeminiLiveProvider;
  compositeRealtime: TavusFullProvider;
  liveAvatar: LiveAvatarProvider;
  simliAvatar: SimliAvatarProvider;
  research: BusinessResearchService;
}): ProviderAdapterRegistration[] {
  return [
    registration("openai-transcription-v1", input.openAITranscription, manifest({
      providerId: "openai-transcription", capabilities: ["speech-input"], supportedModes: ["orchestrated-voice"],
      inputs: ["audio"], outputs: ["text"], transports: ["server-http-turn-buffer"],
      inputAudioFormats: ["pcm-s16le-24000-mono"],
    })),
    registration("openai-synthesis-v1", input.openAISynthesis, manifest({
      providerId: "openai-synthesis", capabilities: ["speech-output"], supportedModes: ["orchestrated-voice"],
      inputs: ["text"], outputs: ["audio"], transports: ["server-http-stream"],
      outputAudioFormats: ["pcm-s16le-24000-mono"],
    })),
    registration("gemini-live-v1", input.googleGeminiLive, manifest({
      providerId: "google-gemini-live", capabilities: ["native-realtime", "reasoning", "speech-input", "speech-output"],
      supportedModes: ["native-realtime"], inputs: ["audio", "text", "tool-result"],
      outputs: ["audio", "text", "tool-call"], transports: ["gemini-live-websocket"],
      reasoningIsReplaceable: false, inputAudioFormats: ["pcm-s16le-16000-mono"],
      outputAudioFormats: ["pcm-s16le-24000-mono"],
      usageDimensions: ["input-tokens", "output-tokens", "audio-input-tokens", "audio-output-tokens"],
      interruptionCapabilities: ["server-barge-in", "client-buffer-clear", "tool-call-cancellation"],
      maxSessionDuration: 540,
    })),
    registration("openai-reasoning-v1", input.openAIReasoning, manifest({
      providerId: "openai-reasoning",
      capabilities: ["reasoning"], supportedModes: ["orchestrated-text", "orchestrated-voice"],
      inputs: ["text", "tool-result"], outputs: ["text", "tool-call"],
      transports: ["server-http-stream"], reasoningIsReplaceable: true,
      usageDimensions: ["input-tokens", "output-tokens", "reasoning-tokens"],
    })),
    registration("anthropic-reasoning-v1", input.anthropicReasoning, manifest({
      providerId: "anthropic-claude-reasoning",
      capabilities: ["reasoning"], supportedModes: ["orchestrated-text", "orchestrated-voice"],
      inputs: ["text", "tool-result"], outputs: ["text", "tool-call"],
      transports: ["server-http-stream"], reasoningIsReplaceable: true,
      usageDimensions: ["input-tokens", "output-tokens", "cached-input-tokens"],
    })),
    registration("gemini-reasoning-v1", input.googleGeminiReasoning, manifest({
      providerId: "google-gemini-reasoning",
      capabilities: ["reasoning"], supportedModes: ["orchestrated-text", "orchestrated-voice"],
      inputs: ["text", "tool-result"], outputs: ["text", "tool-call"],
      transports: ["server-http-stream"], reasoningIsReplaceable: true,
      usageDimensions: ["input-tokens", "output-tokens", "cached-input-tokens", "reasoning-tokens"],
    })),
    registration("native-realtime-v1", input.nativeRealtime, manifest({
      providerId: "native-realtime",
      capabilities: ["native-realtime", "reasoning", "speech-input", "speech-output"],
      supportedModes: ["native-realtime", "orchestrated-voice"],
      inputs: ["audio", "text", "tool-result"], outputs: ["audio", "text", "tool-call"],
      transports: ["webrtc"], reasoningIsReplaceable: false,
    })),
    registration("composite-realtime-v1", input.compositeRealtime, manifest({
      providerId: "composite-realtime",
      capabilities: ["native-realtime", "reasoning", "speech-input", "speech-output", "avatar", "research"],
      supportedModes: ["composite-realtime"],
      inputs: ["audio", "text"], outputs: ["audio", "video", "text", "tool-call"],
      transports: ["provider-meeting"], reasoningIsReplaceable: false,
    })),
    registration("live-avatar-v1", input.liveAvatar, manifest({
      providerId: "live-avatar",
      capabilities: ["avatar"],
      supportedModes: ["orchestrated-voice"],
      inputs: ["text"], outputs: ["video"], transports: ["livekit"],
    })),
    registration("simli-avatar-v1", input.simliAvatar, manifest({
      providerId: "simli-avatar",
      capabilities: ["avatar"], supportedModes: ["orchestrated-voice"],
      inputs: ["audio"], outputs: ["video"], transports: ["livekit", "p2p"],
    })),
    registration("business-research-v1", input.research, manifest({
      providerId: "business-research",
      capabilities: ["research"], supportedModes: ["native-realtime", "orchestrated-text", "orchestrated-voice"],
      inputs: ["text"], outputs: ["text"], transports: ["server-http"],
    })),
  ];
}

function registration(
  adapterKey: string,
  implementation: object,
  providerManifest: ProviderCapabilityManifest,
): ProviderAdapterRegistration {
  return { adapterKey, implementation, manifest: providerManifest };
}

function manifest(input: {
  providerId: string;
  capabilities: string[];
  supportedModes: ProviderCapabilityManifest["supportedModes"];
  inputs: string[];
  outputs: string[];
  transports: string[];
  reasoningIsReplaceable?: boolean;
  usageDimensions?: string[];
  inputAudioFormats?: string[];
  outputAudioFormats?: string[];
  interruptionCapabilities?: string[];
  maxSessionDuration?: number;
}): ProviderCapabilityManifest {
  return {
    providerId: input.providerId,
    adapterVersion: "v1-wrapper.1",
    configurationSchema: { type: "object", additionalProperties: false },
    capabilities: input.capabilities,
    supportedModes: input.supportedModes,
    supportedInputModalities: input.inputs,
    supportedOutputModalities: input.outputs,
    languages: ["en-AU"],
    toolSchemaCapabilities: ["json-schema-object"],
    toolDeliveryModes: ["session-provisioning"],
    transportAdapters: input.transports,
    interruptionCapabilities: input.interruptionCapabilities ?? ["provider-cancel"],
    inputAudioFormats: input.inputAudioFormats ?? (input.inputs.includes("audio") ? ["pcm16"] : []),
    outputAudioFormats: input.outputAudioFormats ?? (input.outputs.includes("audio") ? ["pcm16"] : []),
    usageDimensions: input.usageDimensions ?? ["session-seconds"],
    dataHandlingAssessmentRef: `review://${input.providerId}`,
    credentialRef: `env://${input.providerId}`,
    healthPolicy: { checkKey: `${input.providerId}.health`, maximumAgeSeconds: 60, failClosed: true },
    ...(input.reasoningIsReplaceable === undefined ? {} : { reasoningIsReplaceable: input.reasoningIsReplaceable }),
    ...(input.maxSessionDuration === undefined ? {} : { maxSessionDuration: input.maxSessionDuration }),
  };
}
