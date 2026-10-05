import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("business-pack workspace entitlement migration", () => {
  it("creates tenant-isolated entitlements and append-only audit evidence", () => {
    const sql = readFileSync(resolve(
      dirname(fileURLToPath(import.meta.url)),
      "migrations/060_business_pack_workspace_entitlements.sql",
    ), "utf8");

    expect(sql).toContain("business_pack_entitlements");
    expect(sql).toContain("UNIQUE (customer_id, identity_user_id, pack_id)");
    expect(sql).toContain("business_pack_access_audit_events");
    expect(sql).toContain("Business-pack access audit events are append-only");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements");
    expect(sql).not.toContain("GRANT INSERT ON __SOPHIA_RUNTIME_SCHEMA__.business_pack_entitlements");
  });
});
