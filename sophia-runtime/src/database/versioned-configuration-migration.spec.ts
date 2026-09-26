import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("versioned configuration migration", () => {
  it("is additive and protects every published configuration aggregate", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/006_versioned_configuration_profiles.sql"),
      "utf8",
    );

    for (const table of [
      "business_profiles",
      "business_profile_versions",
      "provider_configurations",
      "capability_bindings",
      "experience_profiles",
      "experience_profile_versions",
      "experience_provider_bindings",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.${table}`);
    }
    expect(sql).toContain("protect_published_configuration");
    expect(sql).toContain("protect_published_capability_binding");
    expect(sql).toContain("protect_published_experience_provider_binding");
    expect(sql).not.toMatch(/DROP TABLE[^;]*ai_configs/i);
    expect(sql).not.toMatch(/(?:api_key|access_token|client_secret|password)\s+text/i);
  });
});
