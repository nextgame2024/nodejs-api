import { readFile } from "node:fs/promises";
import { describe, expect, it } from "@jest/globals";

describe("platform operator Leads tenant migration", () => {
  it("provisions only active internal operator companies without hardcoded identities", async () => {
    const sql = await readFile(
      new URL(
        "./migrations/124_platform_operator_lead_tenant.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("platform_operator_assignments");
    expect(sql).toContain("assignment.status='active'");
    expect(sql).toContain("company.status='active'");
    expect(sql).toContain("INSERT INTO __SOPHIA_RUNTIME_SCHEMA__.customers");
    expect(sql).toContain("existing.external_company_id=assignment.operator_company_id::text");
    expect(sql).toContain("HAVING count(*) > 1");
    expect(sql).not.toContain("admin_memberships");
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });
});
