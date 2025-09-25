import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { findByEmail } from "../models/user.model.js";
import { generateToken } from "../utils/generateToken.js";

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

  const createdAtISO = found.createdAt
    ? new Date(found.createdAt).toISOString()
    : null;
  const updatedAtISO = found.updatedAt
    ? new Date(found.updatedAt).toISOString()
    : null;

  return res.json({
    user: {
      id: found.id,
      email: found.email,
      username: found.username,
      image: found.image || "",
      bio: found.bio || "",
      createdAt: createdAtISO,
      updatedAt: updatedAtISO,
      token,
    },
  });
});
