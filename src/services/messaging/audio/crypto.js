import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
function key(profile) {
  const raw = process.env[profile.mediaKeyEnv];
  if (
    typeof raw !== "string" ||
    !/^\w+$/.test(profile.mediaKeyEnv ?? "") ||
    !/^[a-f0-9]{64}$/i.test(raw)
  )
    throw new Error("Voice encryption is not configured.");
  return Buffer.from(raw, "hex");
}
const fingerprint = (k) =>
  createHash("sha256").update(k).digest("hex").slice(0, 24);
export function encryptAudio(profile, messageId, bytes) {
  const k = key(profile),
    iv = randomBytes(12);
  try {
    const c = createCipheriv("aes-256-gcm", k, iv);
    c.setAAD(Buffer.from(`${profile.customerId}:${messageId}`));
    return {
      ciphertext: Buffer.concat([c.update(bytes), c.final()]),
      iv,
      authTag: c.getAuthTag(),
      keyFingerprint: fingerprint(k),
    };
  } finally {
    k.fill(0);
  }
}
export function decryptAudio(profile, messageId, asset) {
  const k = key(profile);
  try {
    if (fingerprint(k) !== asset.key_fingerprint)
      throw new Error("Audio key unavailable.");
    const d = createDecipheriv("aes-256-gcm", k, asset.iv);
    d.setAAD(Buffer.from(`${profile.customerId}:${messageId}`));
    d.setAuthTag(asset.auth_tag);
    return Buffer.concat([d.update(asset.ciphertext), d.final()]);
  } finally {
    k.fill(0);
  }
}
