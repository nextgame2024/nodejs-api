import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Business Manager MFA security boundary", () => {
  test("keeps every MFA operation behind the authenticated current-user route", () => {
    const routes = read("src/routes/user.routes.js");
    for (const path of ["/user/mfa", "/user/mfa/totp/enrol", "/user/mfa/totp/activate",
      "/user/mfa/totp/step-up"]) {
      expect(routes).toContain(`\"${path}\", authRequired`);
    }
  });

  test("requires password-confirmed enrollment and never sends the encryption payload", () => {
    const controller = read("src/controllers/mfa.controller.js");
    expect(controller).toContain("bcrypt.compare");
    expect(controller).toContain("savePendingMfaFactor(req.user.id, enrollment.encrypted)");
    expect(controller).not.toContain("savePendingMfaFactor(req.user.id, enrollment.secret)");
    expect(controller).toContain('res.setHeader("Cache-Control", "no-store")');
  });

  test("prevents TOTP replay and applies bounded brute-force lockout", () => {
    const model = read("src/models/userMfa.model.js");
    expect(model).toContain("last_verified_counter<$2");
    expect(model).toContain("failed_attempts+1>=5");
    expect(model).toContain("interval '15 minutes'");
    expect(model).toContain("locked_until IS NULL OR locked_until<=now()");
    expect(model).toContain("status IN ('pending','active')");
    expect(read("src/controllers/mfa.controller.js")).toContain("factor.lockedUntil");
  });

  test("rejects future MFA timestamps at both identity boundaries", () => {
    expect(read("src/middlewares/authJwt.js")).toContain("time <= Date.now() + 30_000");
    expect(read("sophia-runtime/src/admin/authorization/admin-auth.guard.ts"))
      .toContain("verifiedAt <= Date.now() + 30_000");
  });
});
