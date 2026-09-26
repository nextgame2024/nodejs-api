import type { PublishableExperienceProfile } from "../../src/platform/configuration/publishable-profile.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const businessProfileVersionId = "44444444-4444-4444-8444-444444444444";
const experienceProfileId = "55555555-5555-4555-8555-555555555555";
const experienceProfileVersionId = "66666666-6666-4666-8666-666666666666";

function provider(
  providerConfigurationId: string,
  bindingId: string,
  providerId: string,
  adapterKey: string,
  capability: string,
  supportedModes: PublishableExperienceProfile["plan"]["pipelineMode"][],
  reasoningIsReplaceable?: boolean,
): PublishableExperienceProfile["providers"][number] {
  return {
    providerConfigurationId,
    bindingId,
    adapterKey,
    credentialRef: `env://${providerId}`,
    settings: { modelAlias: "current-demo" },
    manifest: {
      providerId,
      adapterVersion: "legacy-v1-wrapper.1",
      configurationSchema: { type: "object" },
      capabilities: [capability],
      supportedModes,
      supportedInputModalities: ["audio"],
      supportedOutputModalities: ["audio", "text"],
      languages: ["en-AU"],
      toolSchemaCapabilities: ["object"],
      toolDeliveryModes: ["legacy-v1"],
      transportAdapters: [adapterKey],
      interruptionCapabilities: ["legacy-cancel"],
      inputAudioFormats: ["pcm16"],
      outputAudioFormats: ["pcm16"],
      usageDimensions: ["session-seconds"],
      dataHandlingAssessmentRef: `review://${providerId}`,
      credentialRef: `env://${providerId}`,
      healthPolicy: { checkKey: `${providerId}.health`, maximumAgeSeconds: 60, failClosed: true },
      ...(reasoningIsReplaceable === undefined ? {} : { reasoningIsReplaceable }),
    },
  };
}

function profile(
  experienceId: "essential" | "professional" | "premium",
  pipelineMode: PublishableExperienceProfile["plan"]["pipelineMode"],
  providers: PublishableExperienceProfile["providers"],
  capabilityOwners: Record<string, string>,
): PublishableExperienceProfile {
  return {
    experienceProfileId,
    experienceProfileVersionId,
    businessProfileVersionId,
    revision: 1,
    plan: {
      tenantId,
      agentId: "current-real-estate-agent",
      experienceId,
      profileVersion: "1",
      pipelineMode,
      capabilityOwners,
      providerBindings: Object.entries(capabilityOwners).map(([capability, bindingId]) => {
        const entry = providers.find((candidate) => candidate.bindingId === bindingId);
        if (!entry) throw new Error(`Missing fixture provider ${bindingId}.`);
        return {
          bindingId,
          providerId: entry.manifest.providerId,
          adapterKey: entry.adapterKey,
          capability,
          configurationVersion: entry.manifest.adapterVersion,
        };
      }),
      capabilityBindings: [],
      policyVersion: "p1-policy",
      toolCatalogVersion: "current-real-estate-tools",
      languagePolicy: { defaultLocale: "en-AU", allowedLocales: ["en-AU"] },
      dataPolicy: {
        policyRef: "current-demo-policy",
        transcriptPersistence: "disabled",
        audioPersistence: "disabled",
        processingRegions: [],
      },
      usageLimits: { maximumSessionSeconds: 600, maximumToolCalls: 20 },
      fallbackPolicy: { mode: "none", allowedProfileVersions: [] },
    },
    providers,
    audioOutputOwnerBindingId: providers[0]?.bindingId,
  };
}

const nativeEssential = provider(
  "77777777-7777-4777-8777-777777777777",
  "native-realtime",
  "current-native-realtime",
  "legacy-openai-realtime-browser",
  "native-realtime",
  ["native-realtime"],
);
const nativeProfessional = provider(
  "77777777-7777-4777-8777-777777777778",
  "native-realtime",
  "current-native-realtime",
  "legacy-openai-realtime-browser",
  "native-realtime",
  ["orchestrated-voice"],
);
const avatarProfessional = provider(
  "88888888-8888-4888-8888-888888888888",
  "avatar",
  "current-avatar",
  "legacy-liveavatar-browser",
  "avatar",
  ["orchestrated-voice"],
);
const compositePremium = provider(
  "99999999-9999-4999-8999-999999999999",
  "composite",
  "current-composite-realtime",
  "legacy-tavus-browser",
  "native-realtime",
  ["composite-realtime"],
  false,
);
compositePremium.manifest.capabilities.push("reasoning");

export const currentExperienceProfiles = {
  essential: profile("essential", "native-realtime", [nativeEssential], {
    "native-realtime": "native-realtime",
  }),
  professional: profile("professional", "orchestrated-voice", [nativeProfessional, avatarProfessional], {
    "native-realtime": "native-realtime",
    avatar: "avatar",
  }),
  premium: profile("premium", "composite-realtime", [compositePremium], {
    "native-realtime": "composite",
    reasoning: "composite",
  }),
} as const;
