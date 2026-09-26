import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import {
  profileConfigurationDigest,
  validatePublishableExperienceProfile,
  type PublishableExperienceProfile,
} from "./publishable-profile.js";

type DraftRow = {
  experience_profile_version_id: string;
  experience_profile_id: string;
  business_profile_version_id: string;
  revision: number;
  status: string;
  configuration: unknown;
};

@Injectable()
export class ConfigurationProfileService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async publishExperienceProfile(
    tenantId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<{ versionId: string; digest: string; publishedAt: string }> {
    const schema = runtimeConfig().schema;
    return this.database.tenantTransaction(tenantId, async (client) => {
      const draft = await this.loadDraft(client, schema, tenantId, versionId);
      if (!draft) throw new NotFoundException("Experience profile draft not found.");
      if (draft.status !== "draft" || draft.revision !== expectedRevision) {
        throw new ConflictException("Experience profile draft changed or is no longer publishable.");
      }

      const profile = validatePublishableExperienceProfile({
        ...(draft.configuration as Record<string, unknown>),
        experienceProfileId: draft.experience_profile_id,
        experienceProfileVersionId: draft.experience_profile_version_id,
        businessProfileVersionId: draft.business_profile_version_id,
        revision: draft.revision,
      });
      const digest = profileConfigurationDigest(profile);
      await this.assertReferencedRows(client, schema, tenantId, profile);
      await this.persistProviderBindings(client, schema, profile);

      const publishedAt = new Date().toISOString();
      const update = await client.query(
        `UPDATE ${schema}.experience_profile_versions
         SET status = 'published', configuration_digest = $1,
             published_at = $2::timestamptz, updated_at = $2::timestamptz
         WHERE experience_profile_version_id = $3 AND status = 'draft' AND revision = $4`,
        [digest, publishedAt, versionId, expectedRevision],
      );
      if (update.rowCount !== 1) {
        throw new ConflictException("Experience profile publication lost a concurrent update.");
      }
      await client.query(
        `UPDATE ${schema}.experience_profiles
         SET active_version_id = $1, enabled = true, updated_at = $2::timestamptz
         WHERE experience_profile_id = $3 AND customer_id = $4`,
        [versionId, publishedAt, profile.experienceProfileId, tenantId],
      );
      return { versionId, digest, publishedAt };
    });
  }

  private async loadDraft(
    client: PoolClient,
    schema: string,
    tenantId: string,
    versionId: string,
  ): Promise<DraftRow | undefined> {
    const result = await client.query<DraftRow>(
      `SELECT v.experience_profile_version_id, v.experience_profile_id,
              v.business_profile_version_id, v.revision, v.status, v.configuration
       FROM ${schema}.experience_profile_versions v
       JOIN ${schema}.experience_profiles p ON p.experience_profile_id = v.experience_profile_id
       WHERE v.experience_profile_version_id = $1 AND p.customer_id = $2
       FOR UPDATE`,
      [versionId, tenantId],
    );
    return result.rows[0];
  }

  private async assertReferencedRows(
    client: PoolClient,
    schema: string,
    tenantId: string,
    profile: PublishableExperienceProfile,
  ): Promise<void> {
    const providerIds = profile.providers.map(({ providerConfigurationId }) => providerConfigurationId);
    const providers = await client.query<{ provider_configuration_id: string }>(
      `SELECT provider_configuration_id FROM ${schema}.provider_configurations
       WHERE customer_id = $1 AND status = 'published'
         AND provider_configuration_id = ANY($2::uuid[])`,
      [tenantId, providerIds],
    );
    if (providers.rowCount !== providerIds.length) {
      throw new ConflictException("A provider configuration is unpublished or belongs to another tenant.");
    }

    const business = await client.query(
      `SELECT 1 FROM ${schema}.business_profile_versions v
       JOIN ${schema}.business_profiles p ON p.business_profile_id = v.business_profile_id
       WHERE v.business_profile_version_id = $1 AND p.customer_id = $2
         AND v.status = 'published'`,
      [profile.businessProfileVersionId, tenantId],
    );
    if (business.rowCount !== 1) {
      throw new ConflictException("The business profile is unpublished or belongs to another tenant.");
    }
  }

  private async persistProviderBindings(
    client: PoolClient,
    schema: string,
    profile: PublishableExperienceProfile,
  ): Promise<void> {
    const providerIdByBinding = new Map(
      profile.providers.map((provider) => [provider.bindingId, provider.providerConfigurationId]),
    );
    for (const binding of profile.plan.providerBindings) {
      const providerConfigurationId = providerIdByBinding.get(binding.bindingId);
      if (!providerConfigurationId) {
        throw new ConflictException(`Provider binding ${binding.bindingId} is unresolved.`);
      }
      await client.query(
        `INSERT INTO ${schema}.experience_provider_bindings (
           experience_profile_version_id, provider_configuration_id, capability_key, binding_key
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (experience_profile_version_id, capability_key) DO UPDATE
         SET provider_configuration_id = EXCLUDED.provider_configuration_id,
             binding_key = EXCLUDED.binding_key`,
        [
          profile.experienceProfileVersionId,
          providerConfigurationId,
          binding.capability,
          binding.bindingId,
        ],
      );
    }
  }
}
