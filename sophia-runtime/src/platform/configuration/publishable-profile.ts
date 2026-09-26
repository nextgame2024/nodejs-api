import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProviderCapabilityManifestSchema,
  SessionPlanSchema,
} from "../contracts/v2/sophia-runtime-v2.contracts.js";

const identifier = z.string().trim().min(1).max(160);
const configurationId = z.string().uuid();

export const PublishableExperienceProfileSchema = z.object({
  experienceProfileId: configurationId,
  experienceProfileVersionId: configurationId,
  businessProfileVersionId: configurationId,
  revision: z.number().int().positive(),
  plan: SessionPlanSchema,
  providers: z.array(z.object({
    providerConfigurationId: configurationId,
    bindingId: identifier,
    adapterKey: identifier,
    credentialRef: identifier,
    settings: z.record(z.string(), z.unknown()),
    manifest: ProviderCapabilityManifestSchema,
  }).strict()).min(1),
  audioOutputOwnerBindingId: identifier.optional(),
}).strict();

export type PublishableExperienceProfile = z.infer<typeof PublishableExperienceProfileSchema>;

export function validatePublishableExperienceProfile(
  input: unknown,
): PublishableExperienceProfile {
  const profile = PublishableExperienceProfileSchema.parse(input);
  profile.providers.forEach((provider) => assertNoEmbeddedSecrets(provider.settings));

  const providerByBinding = new Map(
    profile.providers.map((provider) => [provider.bindingId, provider]),
  );
  if (providerByBinding.size !== profile.providers.length) {
    throw new Error("Provider binding IDs must be unique.");
  }

  for (const binding of profile.plan.providerBindings) {
    const configured = providerByBinding.get(binding.bindingId);
    if (!configured) {
      throw new Error(`Provider binding ${binding.bindingId} has no configuration.`);
    }
    if (
      configured.manifest.providerId !== binding.providerId ||
      configured.adapterKey !== binding.adapterKey
    ) {
      throw new Error(`Provider binding ${binding.bindingId} does not match its manifest.`);
    }
    if (!configured.manifest.capabilities.includes(binding.capability)) {
      throw new Error(`Provider binding ${binding.bindingId} does not support ${binding.capability}.`);
    }
    if (!configured.manifest.supportedModes.includes(profile.plan.pipelineMode)) {
      throw new Error(`Provider binding ${binding.bindingId} does not support ${profile.plan.pipelineMode}.`);
    }
  }

  for (const [capability, ownerBindingId] of Object.entries(profile.plan.capabilityOwners)) {
    const binding = profile.plan.providerBindings.find(
      (candidate) => candidate.bindingId === ownerBindingId && candidate.capability === capability,
    );
    if (!binding) {
      throw new Error(`Capability ${capability} has no matching provider owner.`);
    }
  }

  if (
    profile.audioOutputOwnerBindingId &&
    !providerByBinding.has(profile.audioOutputOwnerBindingId)
  ) {
    throw new Error("The audio output owner is not a configured provider binding.");
  }

  if (profile.plan.pipelineMode === "composite-realtime") {
    const nativeOwner = profile.plan.capabilityOwners["native-realtime"];
    const reasoningOwner = profile.plan.capabilityOwners["reasoning"];
    const nativeProvider = nativeOwner ? providerByBinding.get(nativeOwner) : undefined;
    if (
      nativeOwner &&
      reasoningOwner &&
      nativeOwner !== reasoningOwner &&
      nativeProvider?.manifest.reasoningIsReplaceable !== true
    ) {
      throw new Error("This composite provider does not permit a reasoning override.");
    }
  }

  return profile;
}

export function profileConfigurationDigest(profile: PublishableExperienceProfile): string {
  return createHash("sha256").update(stableStringify(profile)).digest("hex");
}

function assertNoEmbeddedSecrets(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEmbeddedSecrets(entry, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (
      normalized !== "credentialref" &&
      /(?:apikey|accesstoken|clientsecret|password|authorization|bearertoken)/.test(normalized)
    ) {
      throw new Error(`Long-lived secret material is forbidden at ${[...path, key].join(".")}.`);
    }
    assertNoEmbeddedSecrets(entry, [...path, key]);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
