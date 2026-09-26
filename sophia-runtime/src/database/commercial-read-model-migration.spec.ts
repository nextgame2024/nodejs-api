import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("commercial read model migration", () => {
  it("separates platform commercial records from usage and gives Runtime no mutation grant", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/028_commercial_read_model.sql"), "utf8");
    expect(sql).toContain("commercial_plan_versions");
    expect(sql).toContain("tenant_commercial_assignments");
    expect(sql).toContain("billing_subscription_references");
    expect(sql).toContain("billing_invoice_references");
    expect(sql).toContain("Published commercial plan versions are immutable");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT SELECT ON");
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*commercial_plan_versions/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*tenant_commercial_assignments/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*billing_subscription_references/);
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*billing_invoice_references/);
    expect(sql).toContain("external_subscription_ref");
    expect(sql).toContain("external_invoice_ref");
    expect(sql).not.toMatch(/payment_intent|checkout_session|card_/i);
  });
});
