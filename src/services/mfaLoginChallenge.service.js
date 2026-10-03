import jwt from "jsonwebtoken";
import { config } from "../config/index.js";

const PURPOSE = "mfa-login";
const AUDIENCE = "business-manager-mfa-login";
const ISSUER = "business-manager";
const EXPIRES_IN_SECONDS = 5 * 60;

export function createMfaLoginChallenge(userId) {
  const token = jwt.sign({ purpose: PURPOSE, userId }, config.jwt.secret, {
    audience: AUDIENCE,
    issuer: ISSUER,
    expiresIn: EXPIRES_IN_SECONDS,
  });
  return { token, expiresInSeconds: EXPIRES_IN_SECONDS };
}

export function verifyMfaLoginChallenge(token) {
  try {
    const payload = jwt.verify(String(token ?? ""), config.jwt.secret, {
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    return payload?.purpose === PURPOSE && typeof payload.userId === "string"
      ? payload.userId : null;
  } catch {
    return null;
  }
}
