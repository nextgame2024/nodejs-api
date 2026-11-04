import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@jest/globals";

describe("internal assistant managed knowledge migration", () => {
  it("provisions a connector-free core knowledge grant for existing and future operators", async () => {
    const sql = await readFile(
      new URL(
        "./migrations/125_internal_assistant_managed_knowledge.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("ensure_internal_assistant_managed_knowledge");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = pg_catalog");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("Runtime customer for company % is inactive");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.business_profiles");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.business_profile_versions");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.capability_bindings");
    expect(sql).toContain("'sophia-ai-managed-knowledge'");
    expect(sql).toContain("'sophia-managed-knowledge'");
    expect(sql).toContain("'core:managed-knowledge@1.0.0'");
    expect(sql).toMatch(/'sophia-managed-knowledge',\s+NULL,/);
    expect(sql).toContain("AFTER INSERT OR UPDATE OF operator_company_id, status");
    expect(sql).toContain("assignment.status = 'active'");
    expect(sql).not.toContain("business-manager-real-estate");
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });
});
