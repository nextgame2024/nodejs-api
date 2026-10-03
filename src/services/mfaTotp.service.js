import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config/index.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function generateTotpEnrollment({ userId, email }) {
  const secret = base32Encode(randomBytes(20));
  const encrypted = encryptTotpSecret(userId, secret);
  const label = `${config.mfa.issuer}:${email}`;
  const query = new URLSearchParams({ secret, issuer: config.mfa.issuer,
    algorithm: "SHA1", digits: String(DIGITS), period: String(PERIOD_SECONDS) });
  return { secret, encrypted,
    otpauthUri: `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}` };
}

export function encryptTotpSecret(userId, secret) {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(userId), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptTotpSecret(userId, encrypted) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), buffer(encrypted.iv));
  decipher.setAAD(Buffer.from(String(userId), "utf8"));
  decipher.setAuthTag(buffer(encrypted.authTag));
  return Buffer.concat([decipher.update(buffer(encrypted.ciphertext)), decipher.final()]).toString("utf8");
}

export function verifyTotp(secret, code, now = Date.now()) {
  const normalized = String(code ?? "").trim();
  if (!/^\d{6}$/.test(normalized) || !Number.isFinite(now)) return null;
  const current = Math.floor(now / 1000 / PERIOD_SECONDS);
  for (const offset of [-1, 0, 1]) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = totp(secret, counter);
    if (timingSafeEqual(Buffer.from(normalized), Buffer.from(expected))) return counter;
  }
  return null;
}

export function mfaConfigured() {
  try { encryptionKey(); return true; } catch { return false; }
}

function encryptionKey() {
  const raw = String(config.mfa.encryptionKey ?? "").trim();
  const key = /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    const error = new Error("BM_MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    error.status = 503;
    throw error;
  }
  return key;
}

function totp(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % (10 ** DIGITS)).padStart(DIGITS, "0");
}

function base32Encode(input) {
  let bits = 0; let value = 0; let output = "";
  for (const byte of input) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  let bits = 0; let value = 0; const bytes = [];
  for (const char of String(input).replace(/=+$/u, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("The stored MFA secret is invalid.");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function buffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
