import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { findByEmail } from "../models/user.model.js";
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
    String(found.password || "")
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
