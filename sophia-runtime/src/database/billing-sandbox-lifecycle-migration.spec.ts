import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing sandbox lifecycle migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/031_billing_sandbox_lifecycle.sql", import.meta.url)), "utf8");

  it("stores payload-free tenant-scoped routing and replay evidence", () => {
    expect(sql).toContain("billing_provider_customers");
    expect(sql).toContain("billing_webhook_events");
    expect(sql).toContain("payload_digest");
    expect(sql).not.toMatch(/raw_payload|card_number|payment_method_details/i);
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
  });

  it("exposes only a narrow customer-to-tenant routing function", () => {
    expect(sql).toContain("resolve_billing_customer_tenant");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION");
  });

  it("allows lifecycle observations but does not grant commercial-plan mutation", () => {
    expect(sql).toContain("GRANT INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_subscription_references");
    expect(sql).toContain("GRANT INSERT, UPDATE ON __SOPHIA_RUNTIME_SCHEMA__.billing_invoice_references");
    expect(sql).not.toMatch(/GRANT .*commercial_plan_versions.*sophia_runtime_app/i);
    expect(sql).not.toMatch(/GRANT .*tenant_commercial_assignments.*sophia_runtime_app/i);
  });
});
