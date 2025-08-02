import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { findByEmail } from "../models/user.model.js";
import { generateToken } from "../utils/generateToken.js";

export const login = asyncHandler(async (req, res) => {
  const {
    user: { email, password },
  } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const found = findByEmail(email);
  if (!found) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const match = await bcrypt.compare(password, found.password);
  if (!match) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = generateToken({
    id: found.id,
    email: found.email,
    username: found.username,
  });

  return res.json({
    user: {
      id: found.id,
      email: found.email,
      username: found.username,
      image: found.image,
      bio: found.bio,
      createdAt: found.createdAt.toISOString(),
      updatedAt: found.updatedAt.toISOString(),
      token,
    },
  });
});
