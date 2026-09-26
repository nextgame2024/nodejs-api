import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("Operational accountability migration", () => {
  it("creates a deduplicated reconcilable usage ledger with forced tenant RLS", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)),
      "migrations/019_operational_accountability.sql"), "utf8");
    expect(sql).toContain("provider_usage_events");
    expect(sql).toContain("UNIQUE (customer_id, source_event_id)");
    expect(sql).toContain("measurement_status IN ('incomplete', 'estimated', 'measured')");
    expect(sql).toContain("cost_table_version");
    expect(sql).toContain("protect_provider_usage_identity");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("sophia_runtime_app");
  });

  it("revokes runtime deletion and makes measured evidence immutable", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)),
      "migrations/020_usage_ledger_hardening.sql"), "utf8");
    expect(sql).toContain("REVOKE DELETE, TRUNCATE");
    expect(sql).toContain("Measured provider usage is immutable");
    expect(sql).toContain("revision <> OLD.revision + 1");
  });
});
