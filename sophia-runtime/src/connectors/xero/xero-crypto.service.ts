import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { XeroConfig } from "./xero.config.js";

type StatePayload = { tenantId: string; identityUserId: string; nonce: string; issuedAt: number };

@Injectable()
export class XeroCryptoService {
  seal(value: string, config: XeroConfig): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url")].join(".");
  }

  open(value: string, config: XeroConfig): string {
    const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue || extra) {
      throw new Error("Encrypted Xero credential has an invalid envelope.");
    }
    const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  signState(payload: StatePayload, config: XeroConfig): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", config.stateSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  verifyState(value: string, config: XeroConfig): StatePayload {
    const [encoded, providedSignature, extra] = value.split(".");
    if (!encoded || !providedSignature || extra) throw new BadRequestException("Invalid Xero authorization state.");
    const expected = createHmac("sha256", config.stateSecret).update(encoded).digest();
    const provided = Buffer.from(providedSignature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new BadRequestException("Invalid Xero authorization state.");
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
    catch { throw new BadRequestException("Invalid Xero authorization state."); }
    if (!validStatePayload(payload)) throw new BadRequestException("Invalid Xero authorization state.");
    if (Date.now() - payload.issuedAt > 10 * 60_000) {
      throw new BadRequestException("Xero authorization state has expired.");
    }
    return payload;
  }

  digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}

function validStatePayload(value: unknown): value is StatePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StatePayload>;
  return typeof candidate.tenantId === "string"
    && /^[0-9a-f-]{36}$/i.test(candidate.tenantId)
    && typeof candidate.identityUserId === "string" && candidate.identityUserId.length > 0
    && typeof candidate.nonce === "string" && candidate.nonce.length >= 32
    && typeof candidate.issuedAt === "number" && Number.isSafeInteger(candidate.issuedAt);
}
