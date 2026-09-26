import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing provider environment migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/036_billing_provider_environment.sql", import.meta.url)), "utf8");
  const contractSql = readFileSync(fileURLToPath(new URL("./migrations/037_billing_provider_environment_contract.sql", import.meta.url)), "utf8");

  it("separates subscription and invoice observations by provider environment", () => {
    expect(sql).toContain("billing_subscription_references");
    expect(sql).toContain("billing_invoice_references");
    expect(sql.match(/ADD COLUMN IF NOT EXISTS provider_environment/g)).toHaveLength(2);
    expect(sql).toContain("UNIQUE (provider_key, provider_environment, external_subscription_ref)");
    expect(sql).toContain("UNIQUE (provider_key, provider_environment, external_invoice_ref)");
    expect(sql).toContain("NEW.provider_environment <> OLD.provider_environment");
    expect(sql).not.toContain("ALTER COLUMN provider_environment DROP DEFAULT");
    expect(contractSql.match(/ALTER COLUMN provider_environment DROP DEFAULT/g)).toHaveLength(2);
  });
});
