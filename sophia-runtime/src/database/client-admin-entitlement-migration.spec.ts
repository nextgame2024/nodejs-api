import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("client administrator module entitlement migration", () => {
  it("adds a constrained module scope and the fixed client role", () => {
    const sql = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/057_client_admin_module_entitlements.sql"),
      "utf8",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS module_scope text[]");
    expect(sql).toContain("'client_administrator'");
    expect(sql).toContain("cardinality(module_scope) > 0");
    expect(sql).toContain("'ADM-16'");
  });
});
