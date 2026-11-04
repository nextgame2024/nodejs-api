import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@jest/globals";

describe("internal assistant OpenAI text experience migration", () => {
  it("publishes an idempotent provider-backed experience for existing and future operators", async () => {
    const sql = await readFile(
      new URL(
        "./migrations/126_internal_assistant_openai_text_experience.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("ensure_internal_assistant_openai_text_experience");
    expect(sql).toContain("ensure_internal_assistant_managed_knowledge");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("stable_configuration_json");
    expect(sql).toContain("public.digest");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.provider_configurations");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.experience_profiles");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.experience_profile_versions");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.experience_provider_bindings");
    expect(sql).toContain("'openai-reasoning-v1'");
    expect(sql).toContain("'env://openai-reasoning'");
    expect(sql).toContain("'orchestrated-text'");
    expect(sql).toContain("'sophia-whatsapp-openai-text'");
    expect(sql).toContain("'sophia-ai-managed-knowledge'");
    expect(sql).toContain("'sophia-managed-knowledge'");
    expect(sql).toContain("'settings', '{}'::jsonb");
    expect(sql).toContain("'transcriptPersistence', 'disabled'");
    expect(sql).toContain("'audioPersistence', 'disabled'");
    expect(sql).toContain("target_provider_settings IS DISTINCT FROM '{}'::jsonb");
    expect(sql).toContain("assignment.status = 'active'");
    expect(sql).not.toMatch(/api[_-]?key|access[_-]?token|client[_-]?secret/i);
  });

  it("keeps future provider expansion outside the initial immutable OpenAI profile", async () => {
    const sql = await readFile(
      new URL(
        "./migrations/126_internal_assistant_openai_text_experience.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).not.toContain("anthropic-reasoning-v1");
    expect(sql).not.toContain("gemini-reasoning-v1");
    expect(sql).toMatch(/additional\s+--\s+provider-backed experiences can be published later/);
  });
});
