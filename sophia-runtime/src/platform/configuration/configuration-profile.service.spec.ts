import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { currentExperienceProfiles } from "../../../test/fixtures/current-experience-profiles.js";
import { ConfigurationProfileService } from "./configuration-profile.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const profile = currentExperienceProfiles.essential;

describe("ConfigurationProfileService", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("publishes a validated immutable version and advances the active pointer", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        experience_profile_version_id: profile.experienceProfileVersionId,
        experience_profile_id: profile.experienceProfileId,
        business_profile_version_id: profile.businessProfileVersionId,
        revision: 1,
        status: "draft",
        configuration: profile,
      }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ provider_configuration_id: profile.providers[0].providerConfigurationId }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const client = { query } as unknown as PoolClient;
    const database = {
      tenantTransaction: jest.fn(async (_tenantId: string, work: (value: PoolClient) => Promise<unknown>) => work(client)),
    };
    const service = new ConfigurationProfileService(database as never);

    const result = await service.publishExperienceProfile(
      tenantId,
      profile.experienceProfileVersionId,
      1,
    );

    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(query).toHaveBeenCalledTimes(6);
    expect(String(query.mock.calls[3]?.[0])).toContain("experience_provider_bindings");
    expect(String(query.mock.calls[4]?.[0])).toContain("status = 'published'");
    expect(String(query.mock.calls[5]?.[0])).toContain("active_version_id");
  });

  it("fails closed when a referenced provider is not published for the tenant", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        experience_profile_version_id: profile.experienceProfileVersionId,
        experience_profile_id: profile.experienceProfileId,
        business_profile_version_id: profile.businessProfileVersionId,
        revision: 1,
        status: "draft",
        configuration: profile,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const client = { query } as unknown as PoolClient;
    const database = {
      tenantTransaction: jest.fn(async (_tenantId: string, work: (value: PoolClient) => Promise<unknown>) => work(client)),
    };
    const service = new ConfigurationProfileService(database as never);

    await expect(service.publishExperienceProfile(
      tenantId,
      profile.experienceProfileVersionId,
      1,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
