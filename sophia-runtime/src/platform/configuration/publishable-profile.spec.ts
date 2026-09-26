import { describe, expect, it } from "@jest/globals";
import { currentExperienceProfiles } from "../../../test/fixtures/current-experience-profiles.js";
import {
  profileConfigurationDigest,
  validatePublishableExperienceProfile,
  type PublishableExperienceProfile,
} from "./publishable-profile.js";

function cloneProfile(profile: PublishableExperienceProfile): PublishableExperienceProfile {
  return structuredClone(profile);
}

describe("publishable experience profiles", () => {
  it.each(Object.entries(currentExperienceProfiles))(
    "represents and validates the current %s composition",
    (_experience, profile) => {
      const validated = validatePublishableExperienceProfile(profile);
      expect(validated.plan.experienceId).toBe(_experience);
      expect(profileConfigurationDigest(validated)).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it("rejects an unsupported provider mode before publication", () => {
    const profile = cloneProfile(currentExperienceProfiles.essential);
    profile.plan.pipelineMode = "orchestrated-text";
    expect(() => validatePublishableExperienceProfile(profile))
      .toThrow("does not support orchestrated-text");
  });

  it("rejects embedded long-lived secrets but accepts credential references", () => {
    const profile = cloneProfile(currentExperienceProfiles.essential);
    profile.providers[0].settings = { apiKey: "not-allowed" };
    expect(() => validatePublishableExperienceProfile(profile))
      .toThrow("Long-lived secret material is forbidden");
  });

  it("rejects a reasoning override for a native-only composite", () => {
    const profile = cloneProfile(currentExperienceProfiles.premium);
    const override = structuredClone(currentExperienceProfiles.essential.providers[0]);
    override.bindingId = "reasoning-override";
    override.manifest.capabilities = ["reasoning"];
    override.manifest.supportedModes = ["composite-realtime"];
    profile.providers.push(override);
    profile.plan.providerBindings.push({
      bindingId: override.bindingId,
      providerId: override.manifest.providerId,
      adapterKey: override.adapterKey,
      capability: "reasoning",
      configurationVersion: override.manifest.adapterVersion,
    });
    profile.plan.capabilityOwners.reasoning = override.bindingId;

    expect(() => validatePublishableExperienceProfile(profile))
      .toThrow("does not permit a reasoning override");
  });
});
