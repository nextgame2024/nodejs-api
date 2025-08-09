import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { generateToken } from "../utils/generateToken.js";
import { createUser, findById, updateUserById } from "../models/user.model.js";

/** POST /api/users  — register (no auth) */
export const registerUser = asyncHandler(async (req, res) => {
  const payload = req.body?.user || {};
  const { username, email, password } = payload;

  if (!username || !email || !password) {
    return res
      .status(400)
      .json({ error: "username, email and password are required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const user = await createUser({ username, email, passwordHash });
    const token = generateToken({
      id: user.id,
      email: user.email,
      username: user.username,
    });

    return res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        image: user.image || "",
        bio: user.bio || "",
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        token,
      },
    });
  } catch (e) {
    // MySQL duplicate entry
    if (e && e.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ error: "Email or username already in use" });
    }
    throw e;
  }
});

/** GET /api/user — current user (auth required) */
export const getCurrentUser = asyncHandler(async (req, res) => {
  const { id, email, username } = req.user; // set by authRequired
  const user = await findById(id);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Issue a token (keeps client state simple)
  const token = generateToken({
    id,
    email: user.email,
    username: user.username,
  });

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      image: user.image || "",
      bio: user.bio || "",
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      token,
    },
  });
});

/** PUT /api/user — update current user (auth required) */
export const updateCurrentUser = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body?.user || {};

  const next = {
    email: payload.email,
    username: payload.username,
    image: payload.image,
    bio: payload.bio,
  };

  if (payload.password) {
    next.passwordHash = await bcrypt.hash(payload.password, 10);
  }

  try {
    const updated = await updateUserById(userId, next);

    const token = generateToken({
      id: updated.id,
      email: updated.email,
      username: updated.username,
    });

    return res.json({
      user: {
        id: updated.id,
        email: updated.email,
        username: updated.username,
        image: updated.image || "",
        bio: updated.bio || "",
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        token,
      },
    });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ error: "Email or username already in use" });
    }
    throw e;
  }
});
