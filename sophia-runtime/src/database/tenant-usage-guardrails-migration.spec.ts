import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("tenant usage guardrails migration", () => {
  it("stores tenant limits separately from ephemeral atomic tool reservations", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)),
      "migrations/030_tenant_usage_guardrails.sql"), "utf8");
    expect(sql).toContain("tenant_usage_guardrails");
    expect(sql).toContain("tool_admission_reservations");
    expect(sql).toContain("provider_cost_alert_microunits");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("uq_tool_admission_provider_deduplication");
    expect(sql).not.toMatch(/GRANT DELETE ON .*tenant_usage_guardrails/);
  });
});
