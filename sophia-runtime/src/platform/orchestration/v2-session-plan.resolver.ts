import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { AgentDraftConfigurationSchema } from "../../admin/agents/agent-authoring.contracts.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { ProviderCapabilityRegistry } from "../../providers/capability/provider-capability.registry.js";
import type { ProviderSessionAdapter } from "../../providers/session/provider-session.interface.js";
import { ProviderSessionRegistry } from "../../providers/session/provider-session.registry.js";
import { ToolRegistryService } from "../../tools/tools.service.js";
import { profileConfigurationDigest, validatePublishableExperienceProfile, type PublishableExperienceProfile } from "../configuration/publishable-profile.js";

type ProfileRow = {
  experience_profile_id: string; experience_profile_version_id: string; business_profile_version_id: string;
  revision: number; configuration: unknown; configuration_digest: string;
};

export type ResolvedV2Plan = {
  profile: PublishableExperienceProfile;
  profileDigest: string;
  agentReleaseId: string;
  agentReleaseDigest: string;
  adapter: ProviderSessionAdapter;
};

@Injectable()
export class V2SessionPlanResolver {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProviderCapabilityRegistry) private readonly providers: ProviderCapabilityRegistry,
    @Inject(ProviderSessionRegistry) private readonly sessions: ProviderSessionRegistry,
    @Inject(ToolRegistryService) private readonly tools: ToolRegistryService,
  ) {}

  async resolve(customerId: string, experienceId: string, locale?: string): Promise<ResolvedV2Plan> {
    const config = runtimeConfig();
    return this.database.tenantTransaction(customerId, async (client) => {
      const selected = await client.query<ProfileRow>(
        `SELECT p.experience_profile_id, v.experience_profile_version_id,
                v.business_profile_version_id, v.revision, v.configuration, v.configuration_digest
         FROM ${config.schema}.experience_profiles p
         JOIN ${config.schema}.experience_profile_versions v ON v.experience_profile_version_id = p.active_version_id
         WHERE p.customer_id = $1 AND p.experience_key = $2 AND p.enabled = true AND v.status = 'published'`,
        [customerId, experienceId],
      );
      const row = selected.rows[0];
      if (!row) throw unsupported("NO_PUBLISHED_PROFILE");
      let profile: PublishableExperienceProfile;
      try {
        profile = validatePublishableExperienceProfile({
          ...(row.configuration as Record<string, unknown>),
          experienceProfileId: row.experience_profile_id,
          experienceProfileVersionId: row.experience_profile_version_id,
          businessProfileVersionId: row.business_profile_version_id,
          revision: row.revision,
        });
      } catch {
        throw unsupported("INVALID_PROFILE_SNAPSHOT");
      }
      if (profile.plan.tenantId !== customerId || profile.plan.experienceId !== experienceId) {
        throw unsupported("PROFILE_SCOPE_MISMATCH");
      }
      if (profile.plan.profileVersion !== profile.experienceProfileVersionId) {
        throw unsupported("PROFILE_VERSION_MISMATCH");
      }
      if (locale && !profile.plan.languagePolicy.allowedLocales.includes(locale)) {
        throw unsupported("LOCALE_NOT_SUPPORTED");
      }
      assertFallbackDataPolicy(profile.plan.fallbackPolicy);
      const digest = profileConfigurationDigest(profile);
      if (digest !== row.configuration_digest) throw new ConflictException("Published profile digest verification failed.");
      await this.assertProviders(client, config.schema, customerId, profile);
      await this.assertBindings(client, config.schema, profile);
      const release = await this.resolveRelease(client, config.schema, customerId, profile);
      if (profile.plan.toolCatalogVersion !== this.tools.catalogVersion()) throw unsupported("TOOL_CATALOG_UNAVAILABLE");
      try {
        this.providers.validateComposition({
          pipelineMode: profile.plan.pipelineMode,
          bindings: profile.plan.providerBindings,
          capabilityOwners: profile.plan.capabilityOwners,
          audioOutputOwnerBindingId: profile.audioOutputOwnerBindingId,
        });
        return { profile, profileDigest: digest, ...release, adapter: this.sessions.resolvePlan(profile.plan) };
      } catch (error) {
        throw unsupported("PROVIDER_COMPOSITION_UNSUPPORTED", error);
      }
    });
  }

  private async assertProviders(client: PoolClient, schema: string, customerId: string, profile: PublishableExperienceProfile) {
    const ids = profile.providers.map((provider) => provider.providerConfigurationId);
    const result = await client.query<{
      provider_configuration_id: string; provider_id: string; adapter_key: string;
      credential_ref: string; settings: unknown; manifest: unknown;
    }>(
      `SELECT provider_configuration_id, provider_id, adapter_key, credential_ref, settings, manifest
       FROM ${schema}.provider_configurations
       WHERE customer_id = $1 AND status = 'published' AND provider_configuration_id = ANY($2::uuid[])`,
      [customerId, ids],
    );
    const actual = new Map(result.rows.map((row) => [row.provider_configuration_id, row]));
    for (const expected of profile.providers) {
      const row = actual.get(expected.providerConfigurationId);
      if (!row || row.provider_id !== expected.manifest.providerId || row.adapter_key !== expected.adapterKey ||
        row.credential_ref !== expected.credentialRef || stable(row.settings) !== stable(expected.settings) ||
        stable(row.manifest) !== stable(expected.manifest)) {
        throw unsupported("PROVIDER_CONFIGURATION_MISMATCH");
      }
      for (const capability of profile.plan.providerBindings
        .filter((binding) => binding.bindingId === expected.bindingId)
        .map((binding) => binding.capability)) {
        this.providers.resolve(expected.adapterKey, capability);
      }
    }
  }

  private async assertBindings(client: PoolClient, schema: string, profile: PublishableExperienceProfile) {
    const result = await client.query<{
      provider_configuration_id: string; capability_key: string; binding_key: string;
    }>(
      `SELECT provider_configuration_id, capability_key, binding_key
       FROM ${schema}.experience_provider_bindings WHERE experience_profile_version_id = $1`,
      [profile.experienceProfileVersionId],
    );
    const providerByBinding = new Map(profile.providers.map((provider) => [provider.bindingId, provider.providerConfigurationId]));
    if (result.rowCount !== profile.plan.providerBindings.length) throw unsupported("PROVIDER_BINDINGS_MISMATCH");
    for (const binding of profile.plan.providerBindings) {
      if (!result.rows.some((row) => row.binding_key === binding.bindingId && row.capability_key === binding.capability &&
        row.provider_configuration_id === providerByBinding.get(binding.bindingId))) {
        throw unsupported("PROVIDER_BINDINGS_MISMATCH");
      }
    }
  }

  private async resolveRelease(client: PoolClient, schema: string, customerId: string, profile: PublishableExperienceProfile) {
    const result = await client.query<{ agent_release_id: string; manifest: unknown; manifest_digest: string }>(
      `SELECT r.agent_release_id, r.manifest, r.manifest_digest
       FROM ${schema}.agents a
       JOIN ${schema}.agent_release_manifests r ON r.agent_release_id = a.active_release_id
       LEFT JOIN ${schema}.agent_release_revocations x ON x.agent_release_id = r.agent_release_id
       WHERE a.customer_id = $1 AND a.status = 'enabled'
         AND (a.agent_id::text = $2 OR a.agent_key = $2) AND x.agent_release_id IS NULL`,
      [customerId, profile.plan.agentId],
    );
    const release = result.rows[0];
    if (!release) throw unsupported("NO_ACTIVE_AGENT_RELEASE");
    const envelope = release.manifest as { configuration?: unknown };
    const configuration = AgentDraftConfigurationSchema.safeParse(envelope?.configuration);
    if (!configuration.success || configuration.data.businessProfileVersionId !== profile.businessProfileVersionId ||
      !configuration.data.experienceProfileVersionIds.includes(profile.experienceProfileVersionId) ||
      profile.plan.capabilityBindings.some((binding) => !configuration.data.capabilityBindingIds.includes(binding.capabilityBindingId))) {
      throw unsupported("AGENT_RELEASE_PROFILE_MISMATCH");
    }
    const capabilityIds = profile.plan.capabilityBindings.map((binding) => binding.capabilityBindingId);
    if (capabilityIds.length) {
      const bindings = await client.query(
        `SELECT 1 FROM ${schema}.capability_bindings b
         LEFT JOIN ${schema}.connector_bindings c ON c.connector_binding_id = b.connector_binding_id
         WHERE b.business_profile_version_id = $1 AND b.enabled = true
           AND b.capability_binding_id = ANY($2::uuid[])
           AND (b.connector_binding_id IS NULL OR c.status = 'active')`,
        [profile.businessProfileVersionId, capabilityIds],
      );
      if (bindings.rowCount !== capabilityIds.length) throw unsupported("CAPABILITY_BINDING_UNAVAILABLE");
    }
    return { agentReleaseId: release.agent_release_id, agentReleaseDigest: release.manifest_digest };
  }
}

function unsupported(reason: string, cause?: unknown): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: "UNSUPPORTED_COMPOSITION",
    reasons: [reason],
    ...(cause instanceof Error ? { detail: cause.message } : {}),
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sessionPlanDigest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export function assertFallbackDataPolicy(policy: { mode: string; allowedProfileVersions: string[] }): void {
  if (policy.mode !== "none" || policy.allowedProfileVersions.length) {
    throw unsupported("FALLBACK_DATA_POLICY_UNVERIFIED");
  }
}
