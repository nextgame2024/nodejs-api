import { describe, expect, it } from "@jest/globals";
import type { ProviderAdapterRegistration } from "./provider-capability.registry.js";
import { PROVIDER_ADAPTER_REGISTRATIONS, ProviderCapabilityRegistry } from "./provider-capability.registry.js";
import { existingProviderRegistrations } from "./provider-adapter.registrations.js";

function adapter(adapterKey: string, capabilities: string[], reasoningIsReplaceable = false): ProviderAdapterRegistration {
  return {
    adapterKey,
    implementation: {},
    manifest: {
      providerId: adapterKey,
      adapterVersion: "test.1",
      configurationSchema: {},
      capabilities,
      supportedModes: ["native-realtime", "composite-realtime", "orchestrated-voice"],
      supportedInputModalities: ["audio", "text"],
      supportedOutputModalities: ["audio", "text"],
      languages: ["en-AU"], toolSchemaCapabilities: ["object"], toolDeliveryModes: ["test"],
      transportAdapters: ["test"], interruptionCapabilities: ["cancel"],
      inputAudioFormats: ["pcm16"], outputAudioFormats: ["pcm16"], usageDimensions: ["seconds"],
      dataHandlingAssessmentRef: "review://test", credentialRef: "env://test",
      healthPolicy: { checkKey: "test", maximumAgeSeconds: 60, failClosed: true },
      reasoningIsReplaceable,
    },
  };
}

describe("ProviderCapabilityRegistry", () => {
  it("accepts a registered mock adapter without changing orchestration", () => {
    const mock = adapter("mock-native", ["native-realtime"]);
    const registry = new ProviderCapabilityRegistry([mock]);
    expect(registry.resolve("mock-native", "native-realtime").implementation).toBe(mock.implementation);
  });

  it("rejects unknown capabilities", () => {
    const registry = new ProviderCapabilityRegistry([adapter("mock", ["avatar"])]);
    expect(() => registry.resolve("mock", "reasoning")).toThrow("does not support reasoning");
  });

  it("rejects a reasoning override for a native-only composite", () => {
    const registry = new ProviderCapabilityRegistry([
      adapter("composite", ["native-realtime"], false),
      adapter("reasoner", ["reasoning"], true),
    ]);
    expect(() => registry.validateComposition({
      pipelineMode: "composite-realtime",
      bindings: [
        { bindingId: "native", adapterKey: "composite", capability: "native-realtime" },
        { bindingId: "reasoning", adapterKey: "reasoner", capability: "reasoning" },
      ],
      capabilityOwners: { "native-realtime": "native", reasoning: "reasoning" },
    })).toThrow("does not permit a reasoning override");
  });

  it("requires one speech owner when outputs overlap", () => {
    const registry = new ProviderCapabilityRegistry([
      adapter("speech-a", ["speech-output"]), adapter("speech-b", ["speech-output"]),
    ]);
    expect(() => registry.validateComposition({
      pipelineMode: "orchestrated-voice",
      bindings: [
        { bindingId: "a", adapterKey: "speech-a", capability: "speech-output" },
        { bindingId: "b", adapterKey: "speech-b", capability: "speech-output" },
      ],
      capabilityOwners: { "speech-output": "a" },
    })).toThrow("declare one audio output owner");
  });

  it("exposes a stable injection token", () => {
    expect(typeof PROVIDER_ADAPTER_REGISTRATIONS).toBe("symbol");
  });

  it("registers text reasoning without implying speech, realtime or avatar support", () => {
    const implementation = {};
    const registration = existingProviderRegistrations({
      nativeRealtime: {} as never,
      openAIReasoning: implementation as never,
      anthropicReasoning: {} as never,
      googleGeminiReasoning: {} as never,
      openAITranscription: {} as never,
      openAISynthesis: {} as never,
      googleGeminiLive: {} as never,
      compositeRealtime: {} as never,
      liveAvatar: {} as never,
      simliAvatar: {} as never,
      research: {} as never,
    }).find((candidate) => candidate.adapterKey === "openai-reasoning-v1");

    expect(registration?.implementation).toBe(implementation);
    expect(registration?.manifest).toMatchObject({
      capabilities: ["reasoning"],
      supportedInputModalities: ["text", "tool-result"],
      supportedOutputModalities: ["text", "tool-call"],
      inputAudioFormats: [],
      outputAudioFormats: [],
      usageDimensions: ["input-tokens", "output-tokens", "reasoning-tokens"],
      reasoningIsReplaceable: true,
    });
  });

  it("registers Claude as a disabled-by-credential interchangeable text reasoner", () => {
    const implementation = {};
    const registration = existingProviderRegistrations({
      nativeRealtime: {} as never,
      openAIReasoning: {} as never,
      anthropicReasoning: implementation as never,
      googleGeminiReasoning: {} as never,
      openAITranscription: {} as never,
      openAISynthesis: {} as never,
      googleGeminiLive: {} as never,
      compositeRealtime: {} as never,
      liveAvatar: {} as never,
      simliAvatar: {} as never,
      research: {} as never,
    }).find((candidate) => candidate.adapterKey === "anthropic-reasoning-v1");

    expect(registration?.implementation).toBe(implementation);
    expect(registration?.manifest).toMatchObject({
      providerId: "anthropic-claude-reasoning",
      capabilities: ["reasoning"],
      supportedInputModalities: ["text", "tool-result"],
      supportedOutputModalities: ["text", "tool-call"],
      inputAudioFormats: [],
      outputAudioFormats: [],
      usageDimensions: ["input-tokens", "output-tokens", "cached-input-tokens"],
      reasoningIsReplaceable: true,
    });
  });

  it("registers Gemini as a disabled-by-credential interchangeable text reasoner", () => {
    const implementation = {};
    const registration = existingProviderRegistrations({
      nativeRealtime: {} as never,
      openAIReasoning: {} as never,
      anthropicReasoning: {} as never,
      googleGeminiReasoning: implementation as never,
      openAITranscription: {} as never,
      openAISynthesis: {} as never,
      googleGeminiLive: {} as never,
      compositeRealtime: {} as never,
      liveAvatar: {} as never,
      simliAvatar: {} as never,
      research: {} as never,
    }).find((candidate) => candidate.adapterKey === "gemini-reasoning-v1");

    expect(registration?.implementation).toBe(implementation);
    expect(registration?.manifest).toMatchObject({
      providerId: "google-gemini-reasoning",
      capabilities: ["reasoning"],
      supportedInputModalities: ["text", "tool-result"],
      supportedOutputModalities: ["text", "tool-call"],
      inputAudioFormats: [],
      outputAudioFormats: [],
      usageDimensions: ["input-tokens", "output-tokens", "cached-input-tokens", "reasoning-tokens"],
      reasoningIsReplaceable: true,
    });
  });

  it("registers exact bounded-turn speech codecs without claiming unimplemented avatar speech", () => {
    const registrations = existingProviderRegistrations({
      nativeRealtime: {} as never, openAIReasoning: {} as never, anthropicReasoning: {} as never,
      googleGeminiReasoning: {} as never, openAITranscription: {} as never, openAISynthesis: {} as never,
      googleGeminiLive: {} as never,
      compositeRealtime: {} as never, liveAvatar: {} as never, simliAvatar: {} as never, research: {} as never,
    });
    expect(registrations.find((item) => item.adapterKey === "openai-transcription-v1")?.manifest)
      .toMatchObject({ capabilities: ["speech-input"], inputAudioFormats: ["pcm-s16le-24000-mono"] });
    expect(registrations.find((item) => item.adapterKey === "openai-synthesis-v1")?.manifest)
      .toMatchObject({ capabilities: ["speech-output"], outputAudioFormats: ["pcm-s16le-24000-mono"] });
    expect(registrations.find((item) => item.adapterKey === "live-avatar-v1")?.manifest)
      .toMatchObject({ capabilities: ["avatar"], inputAudioFormats: [], outputAudioFormats: [] });
    expect(registrations.find((item) => item.adapterKey === "gemini-live-v1")?.manifest).toMatchObject({
      capabilities: ["native-realtime", "reasoning", "speech-input", "speech-output"],
      supportedModes: ["native-realtime"], transportAdapters: ["gemini-live-websocket"],
      inputAudioFormats: ["pcm-s16le-16000-mono"], outputAudioFormats: ["pcm-s16le-24000-mono"],
      reasoningIsReplaceable: false,
    });
  });
});
