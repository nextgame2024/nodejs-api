import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { findByEmail, updateUserById } from "../models/user.model.js";
import {
  createPasswordResetToken,
  findValidPasswordResetToken,
  markPasswordResetTokenUsed,
} from "../models/passwordReset.model.js";
import { sendPasswordResetEmail } from "../services/passwordResetEmail.service.js";
import { generateToken } from "../utils/generateToken.js";

const toISO = (v) => (v ? new Date(v).toISOString() : null);

const mapUserResponse = (u, token) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  image: u.image || "",
  bio: u.bio || "",

  // New fields (optional, backward-compatible)
  name: u.name ?? null,
  address: u.address ?? null,
  cel: u.cel ?? null,
  tel: u.tel ?? null,
  contacts: u.contacts ?? null,
  type: u.type ?? null,
  status: u.status ?? null,
  companyId: u.companyId ?? null,
  companyName: u.companyName ?? null,

  createdAt: toISO(u.createdAt),
  updatedAt: toISO(u.updatedAt),
  token,
});

export const login = asyncHandler(async (req, res) => {
  const { user } = req.body || {};
  const email = user?.email;
  const password = user?.password;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const found = await findByEmail(email);
  if (!found) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const match = await bcrypt.compare(
    String(password || ""),
    String(found.password || ""),
  );
  if (!match) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = generateToken({
    id: found.id,
    email: found.email,
    username: found.username,
  });

  return res.json({ user: mapUserResponse(found, token) });
});

export const requestPasswordReset = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || req.body?.user?.email || "")
    .trim()
    .toLowerCase();

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const found = await findByEmail(email);
  if (found) {
    try {
      const { token } = await createPasswordResetToken({ userId: found.id });
      await sendPasswordResetEmail({ user: found, token });
    } catch (error) {
      console.error("Password reset email failed:", error?.message || error);
    }
  }

  return res.json({
    message:
      "If an account exists for that email, a password reset link has been sent.",
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const password = String(req.body?.password || req.body?.user?.password || "");

  if (!token || !password) {
    return res.status(400).json({ error: "Token and password are required" });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  }

  const resetToken = await findValidPasswordResetToken(token);
  if (!resetToken) {
    return res
      .status(400)
      .json({ error: "This password reset link is invalid or expired" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await updateUserById(resetToken.userId, { passwordHash });
  await markPasswordResetTokenUsed(resetToken.id);

  return res.json({
    message: "Password updated successfully. You can now sign in.",
  });
});
