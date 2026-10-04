import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Business Manager Sophia Admin entitlement boundary", () => {
  test("exports the bulk entitlement operation through both model shapes", () => {
    const model = read("src/models/bm.navigation.links.model.js");
    expect(model).toContain("export async function syncSophiaAdminEntitlements");
    expect(model.slice(model.lastIndexOf("export default"))).toContain(
      "syncSophiaAdminEntitlements",
    );
  });

  test("keeps the special link user scoped and super-admin controlled", () => {
    const controller = read("src/controllers/bm.navigation.links.controller.js");
    expect(controller).toContain('const SOPHIA_ADMIN_LABEL = "Sophia Ai admin"');
    expect(controller).toContain("At least one target user is required for Sophia Admin access");
    expect(controller).toContain("Only the platform super administrator can assign Sophia Admin access");
    expect(controller).toContain("selectedSophiaAdmin && requestedModules.length > 0");
    expect(controller).toContain("A maximum of 100 target users may be updated at once");
  });

  test("revokes the membership rather than treating link visibility as authorization", () => {
    const model = read("src/models/bm.navigation.links.model.js");
    expect(model).toContain("m.role_key = 'client_administrator'");
    expect(model).toContain("authorization_revision = authorization_revision + 1");
    expect(model).toContain("client_admin.entitlement_revoked");
    expect(model).toContain("status = 'revoked', module_scope = NULL");
    expect(model).toContain("syncSophiaAdminEntitlements");
    expect(model).toContain("protectedActiveRole");
  });
});
