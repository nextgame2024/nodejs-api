import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("organisation lifecycle migration", () => {
  it("adds revisioned invitations and membership RLS without deleting identity data", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/011_organisation_membership_lifecycle.sql"),
      "utf8",
    );
    expect(sql).toContain("admin_invitations");
    expect(sql).toContain("token_hash text NOT NULL UNIQUE");
    expect(sql).toContain("admin_memberships FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("admin_memberships_role_key_check");
    expect(sql).toContain("read_only_auditor");
    expect(sql).toContain("settings_revision integer NOT NULL DEFAULT 1");
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM/i);
  });
});
