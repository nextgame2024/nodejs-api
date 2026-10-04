import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Business Manager Sophia Admin entitlement boundary", () => {
  test("keeps the special link user scoped and super-admin controlled", () => {
    const controller = read("src/controllers/bm.navigation.links.controller.js");
    expect(controller).toContain('const SOPHIA_ADMIN_LABEL = "Sophia Ai admin"');
    expect(controller).toContain("target_user_id is required for Sophia Admin access");
    expect(controller).toContain("Only the platform super administrator can assign Sophia Admin access");
    expect(controller).toContain("At least one Sophia Admin module is required");
  });

  test("revokes the membership rather than treating link visibility as authorization", () => {
    const model = read("src/models/bm.navigation.links.model.js");
    expect(model).toContain("m.role_key = 'client_administrator'");
    expect(model).toContain("authorization_revision = authorization_revision + 1");
    expect(model).toContain("client_admin.entitlement_revoked");
    expect(model).toContain("status = 'revoked', module_scope = NULL");
  });
});
