import { readFileSync } from "node:fs";
import { describe, expect, it } from "@jest/globals";

const sql = readFileSync(new URL("./migrations/066_xero_connector_foundation.sql", import.meta.url), "utf8");

describe("Xero connector foundation migration", () => {
  it("keeps OAuth state, authorizations, and connections tenant isolated", () => {
    expect(sql).toContain("xero_oauth_states");
    expect(sql).toContain("xero_authorizations");
    expect(sql).toContain("xero_connections");
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(sql.match(/customer_id = NULLIF\(current_setting\('sophia.tenant_id'/g)).toHaveLength(6);
  });

  it("does not grant deletion of connection or credential records to the runtime role", () => {
    expect(sql).toContain("REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.xero_oauth_states");
    expect(sql).toContain("REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.xero_authorizations");
    expect(sql).toContain("REVOKE DELETE ON __SOPHIA_RUNTIME_SCHEMA__.xero_connections");
    expect(sql).not.toMatch(/GRANT[^;]*DELETE/);
  });
});
