import { beforeEach, describe, expect, jest, test } from "@jest/globals";

const compare = jest.fn();
const findAuthById = jest.fn();
const findMfaFactor = jest.fn();
const disableMfaFactor = jest.fn();
const recordMfaFailure = jest.fn();
const verifyTotp = jest.fn();
const decryptTotpSecret = jest.fn();
const sendMfaDisabledEmail = jest.fn();

jest.unstable_mockModule("bcryptjs", () => ({ default: { compare } }));
jest.unstable_mockModule("../src/models/user.model.js", () => ({
  findAuthById,
  findById: jest.fn(),
}));
jest.unstable_mockModule("../src/models/userMfa.model.js", () => ({
  activateMfaFactor: jest.fn(),
  consumeMfaCounter: jest.fn(),
  disableMfaFactor,
  findMfaFactor,
  recordMfaFailure,
  savePendingMfaFactor: jest.fn(),
}));
jest.unstable_mockModule("../src/services/mfaTotp.service.js", () => ({
  decryptTotpSecret,
  generateTotpEnrollment: jest.fn(),
  mfaConfigured: () => true,
  verifyTotp,
}));
jest.unstable_mockModule("../src/services/mfaSecurityEmail.service.js", () => ({ sendMfaDisabledEmail }));

const { disableTotp } = await import("../src/controllers/mfa.controller.js");

describe("Business Manager MFA deactivation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findAuthById.mockResolvedValue({ id: "user-1", status: "active", password: "hash",
      email: "owner@example.com" });
    compare.mockResolvedValue(true);
    findMfaFactor.mockResolvedValue({ status: "active", ciphertext: Buffer.from("a"),
      iv: Buffer.alloc(12), authTag: Buffer.alloc(16), lockedUntil: null });
    decryptTotpSecret.mockReturnValue("SECRET");
    verifyTotp.mockReturnValue(123);
    disableMfaFactor.mockResolvedValue(true);
    sendMfaDisabledEmail.mockResolvedValue({ sent: true });
  });

  test("requires both credentials, revokes all sessions and sends a notification", async () => {
    const { req, res, next } = request({ password: "current-password", code: "123456" });

    await disableTotp(req, res, next);

    expect(compare).toHaveBeenCalledWith("current-password", "hash");
    expect(verifyTotp).toHaveBeenCalledWith("SECRET", "123456");
    expect(disableMfaFactor).toHaveBeenCalledWith("user-1", 123, expect.objectContaining({
      ipAddress: "203.0.113.1", userAgent: "test-agent",
    }));
    expect(sendMfaDisabledEmail).toHaveBeenCalledWith(expect.objectContaining({
      user: expect.objectContaining({ email: "owner@example.com" }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ sessionsRevoked: true }));
    expect(next).not.toHaveBeenCalled();
  });

  test("does not touch the factor when password confirmation fails", async () => {
    compare.mockResolvedValue(false);
    const { req, res, next } = request({ password: "wrong", code: "123456" });

    await disableTotp(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(disableMfaFactor).not.toHaveBeenCalled();
    expect(sendMfaDisabledEmail).not.toHaveBeenCalled();
  });
});

function request(body) {
  const req = {
    body,
    user: { id: "user-1" },
    ip: "203.0.113.1",
    get: jest.fn().mockReturnValue("test-agent"),
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  return { req, res, next: jest.fn() };
}
