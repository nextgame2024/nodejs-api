import bcrypt from "bcryptjs";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { generateToken } from "../utils/generateToken.js";
import {
  createUser,
  findById,
  updateUserById,
  listUsersByCompany,
  countUsersByCompany,
  userHasRelatedProcesses,
  archiveUserById,
  deleteUserById,
} from "../models/user.model.js";
import pool from "../config/db.js";

const toISO = (v) => (v ? new Date(v).toISOString() : null);
const SUPER_ADMIN_ID = "c2dad143-077c-4082-92f0-47805601db3b";
const DEFAULT_REGISTRATION_COMPANY_ID =
  process.env.REGISTRATION_COMPANY_ID ||
  "81c2f065-aceb-4043-add5-b11271d21fb3";
const isSuperAdmin = (req) => req.user?.id === SUPER_ADMIN_ID;
const USER_TYPES = new Set(["employee", "supplier", "client"]);
const USER_STATUSES = new Set(["active", "archived"]);

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
  hasProcesses: Boolean(u.hasProcesses),
  companyId: u.companyId ?? null,
  companyName: u.companyName ?? null,

  createdAt: toISO(u.createdAt),
  updatedAt: toISO(u.updatedAt),
  token,
});

const normalizeOptionalEnum = (value, allowed) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  return allowed.has(normalized) ? normalized : null;
};

/** POST /api/users  — register (no auth) */
export const registerUser = asyncHandler(async (req, res) => {
  const payload = req.body?.user || {};
  const { username, email, password } = payload;
  const requestedCompanyId = payload.companyId ?? payload.company_id ?? null;

  if (!username || !email || !password) {
    return res
      .status(400)
      .json({ error: "username, email and password are required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let companyId = null;

  if (req.user?.id) {
    const { rows } = await pool.query(
      `SELECT company_id FROM users WHERE id = $1 LIMIT 1`,
      [req.user.id],
    );
    companyId = rows[0]?.company_id ?? null;
    if (isSuperAdmin(req)) {
      if (!requestedCompanyId) {
        return res
          .status(400)
          .json({ error: "companyId is required for super admin" });
      }
      const { rows: companyRows } = await pool.query(
        `SELECT company_id
         FROM bm_company
         WHERE company_id = $1
         LIMIT 1`,
        [requestedCompanyId],
      );
      if (!companyRows[0]?.company_id) {
        return res.status(400).json({ error: "Invalid companyId" });
      }
      companyId = companyRows[0].company_id;
    } else if (!companyId) {
      return res
        .status(403)
        .json({ error: "User is not assigned to a company" });
    }
  } else {
    companyId = DEFAULT_REGISTRATION_COMPANY_ID;
    if (requestedCompanyId && requestedCompanyId !== companyId) {
      return res.status(400).json({ error: "Invalid companyId" });
    }
    const { rows: companyRows } = await pool.query(
      `SELECT company_id
       FROM bm_company
       WHERE company_id = $1
       LIMIT 1`,
      [companyId],
    );
    if (!companyRows[0]?.company_id) {
      return res.status(400).json({ error: "Invalid companyId" });
    }
  }

  // New optional fields (safe; do not break existing clients)
  const optional = {
    image: payload.image ?? "",
    bio: payload.bio ?? "",
    name: payload.name ?? null,
    address: payload.address ?? null,
    cel: payload.cel ?? null,
    tel: payload.tel ?? null,
    contacts: payload.contacts ?? null, // expect JSON object/array or null
  };
  let type = "employee";
  if (payload.type !== undefined) {
    const normalizedType = normalizeOptionalEnum(payload.type, USER_TYPES);
    if (!normalizedType) {
      return res.status(400).json({ error: "Invalid user type" });
    }
    type = normalizedType;
  }

  let status = "active";
  if (payload.status !== undefined) {
    const normalizedStatus = normalizeOptionalEnum(payload.status, USER_STATUSES);
    if (!normalizedStatus) {
      return res.status(400).json({ error: "Invalid user status" });
    }
    status = normalizedStatus;
  }

  try {
    const user = await createUser({
      username,
      email,
      passwordHash,
      companyId,
      type,
      status,
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

/** GET /api/users — list users in company (auth required) */
export const listUsers = asyncHandler(async (req, res) => {
  const companyId = isSuperAdmin(req) ? null : req.user.companyId;

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const offset = (page - 1) * limit;

  const q = (req.query.q || "").toString().trim();
  const status = (req.query.status || "").toString().trim() || null;
  const rawType =
    req.query.type === undefined
      ? undefined
      : req.query.type?.toString?.() ?? req.query.type;
  const type = normalizeOptionalEnum(rawType, USER_TYPES);
  if (rawType !== undefined && !type) {
    return res.status(400).json({ error: "Invalid user type" });
  }

  const [users, total] = await Promise.all([
    listUsersByCompany({
      companyId,
      q,
      status,
      type,
      limit,
      offset,
    }),
    countUsersByCompany({ companyId, q, status, type }),
  ]);

  return res.json({
    users,
    page,
    limit,
    total,
  });
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

/** PUT /api/users/:id — update any user in company (auth required) */
export const updateUserByAdmin = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const superAdmin = isSuperAdmin(req);
  const userId = req.params.id;
  const payload = req.body?.user || {};

  const target = await findById(userId);
  if (!target) return res.status(404).json({ error: "User not found" });

  // company guard
  if (!superAdmin && target.companyId && target.companyId !== companyId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const next = {
    email: payload.email,
    username: payload.username,
    image: payload.image,
    bio: payload.bio,

    name: payload.name,
    address: payload.address,
    cel: payload.cel,
    tel: payload.tel,
    contacts: payload.contacts,
  };

  if (payload.type !== undefined) {
    const type = normalizeOptionalEnum(payload.type, USER_TYPES);
    if (!type) return res.status(400).json({ error: "Invalid user type" });
    next.type = type;
  }

  if (payload.status !== undefined) {
    const status = normalizeOptionalEnum(payload.status, USER_STATUSES);
    if (!status) return res.status(400).json({ error: "Invalid user status" });
    next.status = status;
  }

  if (superAdmin && (payload.companyId !== undefined || payload.company_id !== undefined)) {
    const requestedCompanyId = payload.companyId ?? payload.company_id ?? null;
    if (!requestedCompanyId) {
      return res
        .status(400)
        .json({ error: "companyId is required for super admin" });
    }
    const { rows: companyRows } = await pool.query(
      `SELECT company_id
       FROM bm_company
       WHERE company_id = $1
       LIMIT 1`,
      [requestedCompanyId],
    );
    if (!companyRows[0]?.company_id) {
      return res.status(400).json({ error: "Invalid companyId" });
    }
    next.companyId = companyRows[0].company_id;
  }

  if (payload.password) {
    next.passwordHash = await bcrypt.hash(payload.password, 10);
  }

  try {
    const updated = await updateUserById(userId, next);

    return res.json({ user: mapUserResponse(updated) });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return res
        .status(409)
        .json({ error: "Email or username already in use" });
    }
    throw e;
  }
});

/** DELETE /api/users/:id — delete/archive user in company (auth required) */
export const removeUserByAdmin = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const superAdmin = isSuperAdmin(req);
  const userId = req.params.id;

  const target = await findById(userId);
  if (!target) return res.status(404).json({ error: "User not found" });

  if (!superAdmin && target.companyId && target.companyId !== companyId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const hasProcesses = await userHasRelatedProcesses(
    userId,
    target.companyId ?? null
  );
  if (hasProcesses) {
    const archived = await archiveUserById(userId);
    if (!archived) return res.status(404).json({ error: "User not found" });
    return res.json({ userId, action: "archived" });
  }

  try {
    const deleted = await deleteUserById(userId);
    if (!deleted) return res.status(404).json({ error: "User not found" });
    return res.json({ userId, action: "deleted" });
  } catch (e) {
    // Fallback to archive when hidden DB relations block hard delete.
    if (e?.code === "23503") {
      const archived = await archiveUserById(userId);
      if (!archived) return res.status(404).json({ error: "User not found" });
      return res.json({ userId, action: "archived" });
    }
    throw e;
  }
});
