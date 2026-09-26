import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing Checkout intents migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/033_billing_checkout_intents.sql", import.meta.url)), "utf8");

  it("binds a provider Checkout reference to one tenant, request and approved plan", () => {
    expect(sql).toContain("billing_checkout_intents");
    expect(sql).toContain("commercial_plan_version_id");
    expect(sql).toContain("external_checkout_ref");
    expect(sql).toContain("UNIQUE (provider_key, provider_environment, external_checkout_ref)");
  });

  it("uses forced RLS and an immutable one-way lifecycle", () => {
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("protect_billing_checkout_intent");
    expect(sql).toContain("OLD.status <> 'created'");
    expect(sql).toContain("NEW.status NOT IN ('completed', 'expired')");
  });
});
