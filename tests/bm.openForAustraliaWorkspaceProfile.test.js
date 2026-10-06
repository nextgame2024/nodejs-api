import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Open For Australia workspace administration", () => {
  test("uses an extensible workspace profile with the map as the safe default", () => {
    const sql = read("../scripts/sql/bm_company_workspace_profile.sql");
    const model = read("../src/models/bm.company.model.js");
    expect(sql).toContain("workspace_profile text NOT NULL DEFAULT 'project_map'");
    expect(sql).toContain("'student_operations'");
    expect(model).toContain('workspace_profile AS "workspaceProfile"');
  });

  test("keeps workspace profile mutation server-authorized", () => {
    const controller = read("../src/controllers/bm.company.controller.js");
    expect(controller).toContain("delete payload.workspace_profile");
    expect(controller).toContain("validateWorkspaceProfile(payload)");
  });

  test("administers named pack roles rather than a boolean entitlement", () => {
    const model = read("../src/models/bm.business.pack.entitlements.model.js");
    const controller = read("../src/controllers/bm.business.pack.entitlements.controller.js");
    const routes = read("../src/routes/bm.business.pack.entitlements.routes.js");
    expect(model).toContain('"open-for-australia"');
    expect(model).toContain('"chief_executive", "operations", "advisor"');
    expect(model).toContain("business_pack.entitlement.revoked");
    expect(model).toContain("authorization_revision = authorization_revision + 1");
    expect(model).toContain("business_pack_access_audit_events");
    expect(model).toContain("set_config('sophia.tenant_id'");
    expect(model).toContain("rc.external_company_id = c.company_id::text");
    expect(controller).toContain("requireSuperAdmin");
    expect(routes).toContain('"/bm/business-pack-entitlements/:userId"');
    expect(routes).toContain("authRequired");
    expect(routes).toContain("setBusinessPackEntitlement");
    expect(model).not.toContain("enabled");
  });
});
