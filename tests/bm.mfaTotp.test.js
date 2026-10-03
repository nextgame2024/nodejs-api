import { describe, expect, test } from "@jest/globals";
import { config } from "../src/config/index.js";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpEnrollment,
  verifyTotp,
} from "../src/services/mfaTotp.service.js";
import {
  createMfaLoginChallenge,
  verifyMfaLoginChallenge,
} from "../src/services/mfaLoginChallenge.service.js";

describe("Business Manager TOTP MFA", () => {
  const originalKey = config.mfa.encryptionKey;
  const originalJwtSecret = config.jwt.secret;

  afterEach(() => {
    config.mfa.encryptionKey = originalKey;
    config.jwt.secret = originalJwtSecret;
  });

  test("matches the RFC 6238 SHA-1 vector with a six-digit authenticator code", () => {
    expect(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287082", 59_000)).toBe(1);
    expect(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "287083", 59_000)).toBeNull();
  });

  test("encrypts the factor with user-bound authenticated encryption", () => {
    config.mfa.encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptTotpSecret("user-1", "JBSWY3DPEHPK3PXP");
    expect(decryptTotpSecret("user-1", encrypted)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptTotpSecret("user-2", encrypted)).toThrow();
  });

  test("creates a standard enrollment URI without persisting plaintext", () => {
    config.mfa.encryptionKey = Buffer.alloc(32, 9).toString("base64");
    const enrollment = generateTotpEnrollment({ userId: "user-1", email: "owner@example.com" });
    expect(enrollment.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrollment.otpauthUri).toContain("otpauth://totp/");
    expect(enrollment.otpauthUri).toContain("algorithm=SHA1");
    expect(decryptTotpSecret("user-1", enrollment.encrypted)).toBe(enrollment.secret);
  });

  test("fails closed without a valid 32-byte encryption key", () => {
    config.mfa.encryptionKey = "not-a-key";
    expect(() => encryptTotpSecret("user-1", "JBSWY3DPEHPK3PXP"))
      .toThrow("base64-encoded 32-byte key");
  });

  test("uses a short-lived purpose-bound login challenge rather than an application token", () => {
    config.jwt.secret = "mfa-login-test-secret";
    const challenge = createMfaLoginChallenge("user-1");
    expect(challenge.expiresInSeconds).toBe(300);
    expect(verifyMfaLoginChallenge(challenge.token)).toBe("user-1");
    expect(verifyMfaLoginChallenge(`${challenge.token}x`)).toBeNull();
  });
});
