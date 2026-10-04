import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("client administrator revocation migration", () => {
  it("requires module scope only while the client membership is active", () => {
    const sql = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "migrations/058_allow_revoked_client_admin_membership.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("role_key <> 'client_administrator'");
    expect(sql).toContain("OR status <> 'active'");
    expect(sql).toContain("cardinality(module_scope) > 0");
  });
});
