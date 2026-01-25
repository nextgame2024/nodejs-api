import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { generateToken } from "../utils/generateToken.js";
import { createUser, findById, updateUserById } from "../models/user.model.js";

const toISO = (v) => (v ? new Date(v).toISOString() : null);

const isUniqueViolation = (e) =>
  e?.code === "23505" || e?.code === "ER_DUP_ENTRY"; // PG + legacy MySQL check

const mapUserResponse = (u, token) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  image: u.image || "",
  bio: u.bio || "",

  // New fields (optional)
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

  // New optional fields (safe; do not break existing clients)
  const optional = {
    name: payload.name ?? null,
    address: payload.address ?? null,
    cel: payload.cel ?? null,
    tel: payload.tel ?? null,
    contacts: payload.contacts ?? null, // expect JSON object/array or null
  };

  try {
    const user = await createUser({
      username,
      email,
      passwordHash,
      ...optional,
    });

    const token = generateToken({
      id: user.id,
      email: user.email,
      username: user.username,
    });

    return res.status(201).json({ user: mapUserResponse(user, token) });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return res
        .status(409)
        .json({ error: "Email or username already in use" });
    }
    throw e;
  }
});

/** GET /api/user — current user (auth required) */
export const getCurrentUser = asyncHandler(async (req, res) => {
  const { id } = req.user; // set by authRequired
  const user = await findById(id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const token = generateToken({
    id,
    email: user.email,
    username: user.username,
  });

  return res.json({ user: mapUserResponse(user, token) });
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

    // New optional fields
    name: payload.name,
    address: payload.address,
    cel: payload.cel,
    tel: payload.tel,
    contacts: payload.contacts,
  };

  // Security: do NOT allow changing type/status here
  // (If you later want admin-only endpoints, we add separate routes.)

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

    return res.json({ user: mapUserResponse(updated, token) });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return res
        .status(409)
        .json({ error: "Email or username already in use" });
    }
    throw e;
  }
});
