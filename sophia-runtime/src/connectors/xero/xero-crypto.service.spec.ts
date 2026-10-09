import { describe, expect, it } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { XeroCryptoService } from "./xero-crypto.service.js";
import type { XeroConfig } from "./xero.config.js";

const config: XeroConfig = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://runtime.example/api/connectors/xero/v1/oauth/callback",
  returnUrl: "https://app.example/manager/company",
  stateSecret: "state-secret-that-is-longer-than-thirty-two-characters",
  encryptionKey: Buffer.alloc(32, 7),
};

describe("XeroCryptoService", () => {
  const service = new XeroCryptoService();

  it("encrypts credentials with a fresh authenticated envelope", () => {
    const first = service.seal("refresh-token", config);
    const second = service.seal("refresh-token", config);
    expect(first).not.toEqual(second);
    expect(first).not.toContain("refresh-token");
    expect(service.open(first, config)).toBe("refresh-token");
    const tamperIndex = Math.floor(first.length / 2);
    const tampered = `${first.slice(0, tamperIndex)}${first[tamperIndex] === "A" ? "B" : "A"}${first.slice(tamperIndex + 1)}`;
    expect(() => service.open(tampered, config)).toThrow();
  });

  it("signs tenant-bound short-lived OAuth state and rejects tampering", () => {
    const state = service.signState({
      tenantId: "11111111-1111-4111-8111-111111111111",
      identityUserId: "user-1",
      nonce: "n".repeat(32),
      issuedAt: Date.now(),
    }, config);
    expect(service.verifyState(state, config)).toMatchObject({
      tenantId: "11111111-1111-4111-8111-111111111111",
      identityUserId: "user-1",
    });
    expect(() => service.verifyState(`${state}x`, config)).toThrow(BadRequestException);
  });
});
