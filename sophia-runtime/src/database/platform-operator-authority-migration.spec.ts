import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

describe("platform operator authority migration", () => {
  it("separates internal operator authority from tenant memberships", () => {
    const sql = readFileSync(resolve(
      dirname(fileURLToPath(import.meta.url)),
      "migrations/059_platform_operator_authority.sql",
    ), "utf8");

    expect(sql).toContain("platform_operator_assignments");
    expect(sql).toContain("operator_company_id uuid NOT NULL");
    expect(sql).toContain("identity_user_id text NOT NULL UNIQUE");
    expect(sql).toContain("platform_operator_audit_events");
    expect(sql).not.toContain("REFERENCES __SOPHIA_RUNTIME_SCHEMA__.customers");
  });
});
