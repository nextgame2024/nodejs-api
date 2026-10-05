import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("Open For Australia entitlement role migration", () => {
  it("requires a fixed role for active Open For Australia entitlements", () => {
    const sql = readFileSync(resolve(
      dirname(fileURLToPath(import.meta.url)),
      "migrations/061_open_for_australia_entitlement_roles.sql",
    ), "utf8");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS role_key text");
    expect(sql).toContain("pack_id <> 'open-for-australia'");
    expect(sql).toContain("status <> 'active'");
    expect(sql).toContain("role_key IS NOT NULL");
    expect(sql).toContain("'chief_executive', 'operations', 'advisor'");
  });
});
