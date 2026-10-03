import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { generateToken } from "../utils/generateToken.js";
import { findAuthById, findById } from "../models/user.model.js";
import {
  activateMfaFactor,
  consumeMfaCounter,
  disableMfaFactor,
  findMfaFactor,
  recordMfaFailure,
  savePendingMfaFactor,
} from "../models/userMfa.model.js";
import {
  decryptTotpSecret,
  generateTotpEnrollment,
  mfaConfigured,
  verifyTotp,
} from "../services/mfaTotp.service.js";
import { sendMfaDisabledEmail } from "../services/mfaSecurityEmail.service.js";

const toIso = (value) => value ? new Date(value).toISOString() : null;

export const getMfaStatus = asyncHandler(async (req, res) => {
  const factor = await findMfaFactor(req.user.id);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ mfa: publicStatus(factor), mfaVerifiedAt: req.user.mfaVerifiedAt ?? null });
});

export const enrolTotp = asyncHandler(async (req, res) => {
  requireConfigured();
  const password = String(req.body?.password ?? "");
  const user = await findAuthById(req.user.id);
  if (!user || user.status !== "active" || !await bcrypt.compare(password, String(user.password ?? ""))) {
    return res.status(401).json({ error: "Current password verification failed" });
  }
  const existing = await findMfaFactor(req.user.id);
  if (existing?.status === "active") return res.status(409).json({ error: "TOTP MFA is already active" });
  const enrollment = generateTotpEnrollment({ userId: req.user.id, email: user.email });
  if (!await savePendingMfaFactor(req.user.id, enrollment.encrypted)) {
    return res.status(409).json({ error: "TOTP MFA is already active" });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(201).json({ mfa: { status: "pending", secret: enrollment.secret,
    otpauthUri: enrollment.otpauthUri } });
});

export const activateTotp = asyncHandler(async (req, res) => {
  requireConfigured();
  const factor = await findMfaFactor(req.user.id);
  if (!factor || factor.status !== "pending") {
    return res.status(409).json({ error: "No pending TOTP enrollment exists" });
  }
  if (factor.lockedUntil && new Date(factor.lockedUntil).getTime() > Date.now()) {
    return res.status(429).json({ error: "MFA verification is temporarily locked",
      lockedUntil: toIso(factor.lockedUntil) });
  }
  const counter = verifyTotp(decryptTotpSecret(req.user.id, factor), req.body?.code);
  if (counter === null) return invalidCode(req, res, "Invalid authenticator code");
  const activated = await activateMfaFactor(req.user.id, counter);
  if (!activated) return res.status(409).json({ error: "The authenticator code was already used" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ mfa: { status: "active", enabled: true, activatedAt: toIso(activated.activatedAt) } });
});

export const stepUpTotp = asyncHandler(async (req, res) => {
  requireConfigured();
  const factor = await findMfaFactor(req.user.id);
  if (!factor || factor.status !== "active") return res.status(409).json({ error: "TOTP MFA is not active" });
  if (factor.lockedUntil && new Date(factor.lockedUntil).getTime() > Date.now()) {
    return res.status(429).json({ error: "MFA verification is temporarily locked", lockedUntil: toIso(factor.lockedUntil) });
  }
  const counter = verifyTotp(decryptTotpSecret(req.user.id, factor), req.body?.code);
  if (counter === null) return invalidCode(req, res, "Invalid or already-used authenticator code");
  const consumed = await consumeMfaCounter(req.user.id, counter);
  if (!consumed) return invalidCode(req, res, "Invalid or already-used authenticator code");
  const user = await findById(req.user.id);
  if (!user || user.status !== "active") return res.status(401).json({ error: "User is not active" });
  const mfaVerifiedAt = toIso(consumed.verifiedAt);
  const token = generateToken({ id: user.id, email: user.email, username: user.username,
    authSessionVersion: user.authSessionVersion ?? 0, mfaVerifiedAt });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ user: { ...user, token, mfaEnabled: true, mfaVerifiedAt } });
});

export const disableTotp = asyncHandler(async (req, res) => {
  requireConfigured();
  const password = String(req.body?.password ?? "");
  const user = await findAuthById(req.user.id);
  if (!user || user.status !== "active" || !await bcrypt.compare(password, String(user.password ?? ""))) {
    return res.status(401).json({ error: "Current password verification failed" });
  }
  const factor = await findMfaFactor(req.user.id);
  if (!factor || factor.status !== "active") {
    return res.status(409).json({ error: "TOTP MFA is not active" });
  }
  if (factor.lockedUntil && new Date(factor.lockedUntil).getTime() > Date.now()) {
    return res.status(429).json({ error: "MFA verification is temporarily locked",
      lockedUntil: toIso(factor.lockedUntil) });
  }
  const counter = verifyTotp(decryptTotpSecret(req.user.id, factor), req.body?.code);
  if (counter === null) return invalidCode(req, res, "Invalid or already-used authenticator code");
  const disabled = await disableMfaFactor(req.user.id, counter, {
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  if (!disabled) return invalidCode(req, res, "Invalid or already-used authenticator code");
  try {
    await sendMfaDisabledEmail({ user });
  } catch (error) {
    console.error("MFA disabled notification failed:", error?.message || error);
  }
  res.setHeader("Cache-Control", "no-store");
  return res.json({ mfa: { status: "not_enrolled", enabled: false }, sessionsRevoked: true });
});

async function invalidCode(req, res, message) {
  const failure = await recordMfaFailure(req.user.id);
  if (failure?.lockedUntil && new Date(failure.lockedUntil).getTime() > Date.now()) {
    return res.status(429).json({ error: "MFA verification is temporarily locked",
      lockedUntil: toIso(failure.lockedUntil) });
  }
  return res.status(401).json({ error: message });
}

function publicStatus(factor) {
  if (!factor) return { enabled: false, status: "not_enrolled", lockedUntil: null };
  return { enabled: factor.status === "active", status: factor.status,
    activatedAt: toIso(factor.activatedAt), lockedUntil: toIso(factor.lockedUntil) };
}

function requireConfigured() {
  if (mfaConfigured()) return;
  const error = new Error("MFA encryption is not configured"); error.status = 503; throw error;
}
