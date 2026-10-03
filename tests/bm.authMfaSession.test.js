import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const verify = jest.fn();
const query = jest.fn();

jest.unstable_mockModule("jsonwebtoken", () => ({ default: { verify } }));
jest.unstable_mockModule("../src/config/index.js", () => ({
  config: { jwt: { secret: "test-secret" } },
}));
jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { query },
}));

const { authRequired } = await import("../src/middlewares/authJwt.js");

describe("Business Manager MFA application-session boundary", () => {
  beforeEach(() => {
    verify.mockReset();
    query.mockReset();
    verify.mockReturnValue({ sub: { id: "user-1", email: "owner@example.com" } });
  });

  test("rejects a password-only token as soon as the factor is active", async () => {
    query.mockResolvedValue({ rows: [{ company_id: "company-1", status: "active", mfa_enabled: true }] });
    const { req, res, next } = request();

    await authRequired(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "MFA_AUTHENTICATION_REQUIRED" }));
    expect(next).not.toHaveBeenCalled();
  });

  test("accepts a recent MFA login and preserves its server timestamp", async () => {
    const mfaVerifiedAt = new Date(Date.now() - 60_000).toISOString();
    verify.mockReturnValue({ sub: { id: "user-1", email: "owner@example.com", mfaVerifiedAt } });
    query.mockResolvedValue({ rows: [{ company_id: "company-1", status: "active", mfa_enabled: true }] });
    const { req, res, next } = request();

    await authRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(expect.objectContaining({ mfaVerifiedAt }));
    expect(res.status).not.toHaveBeenCalled();
  });

  test("rejects an MFA session older than twelve hours", async () => {
    verify.mockReturnValue({ sub: {
      id: "user-1",
      email: "owner@example.com",
      mfaVerifiedAt: new Date(Date.now() - (12 * 60 * 60 * 1000) - 1_000).toISOString(),
    } });
    query.mockResolvedValue({ rows: [{ company_id: "company-1", status: "active", mfa_enabled: true }] });
    const { req, res, next } = request();

    await authRequired(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("does not require MFA from an account without an active factor", async () => {
    query.mockResolvedValue({ rows: [{ company_id: "company-1", status: "active", mfa_enabled: false }] });
    const { req, res, next } = request();

    await authRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(expect.objectContaining({ id: "user-1", companyId: "company-1" }));
  });
});

function request() {
  const req = { headers: { authorization: "Bearer signed-token" } };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { req, res, next: jest.fn() };
}
