import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as model from "../models/bm.business.pack.entitlements.model.js";

const SUPER_ADMIN_ID = "c2dad143-077c-4082-92f0-47805601db3b";
const isSuperAdmin = (req) => req.user?.id === SUPER_ADMIN_ID;
const clean = (value) => String(value ?? "").trim();

function requireSuperAdmin(req, res) {
  if (isSuperAdmin(req)) return true;
  res.status(403).json({ error: "Platform super administrator access is required" });
  return false;
}

export const getBusinessPackEntitlement = asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const companyId = clean(req.query.companyId);
  const targetUserId = clean(req.query.userId);
  const packId = clean(req.query.packId);
  if (!companyId || !targetUserId || !packId) {
    return res.status(400).json({ error: "companyId, userId and packId are required" });
  }
  if (!model.getPackDefinition(packId)) {
    return res.status(400).json({ error: "Unsupported business pack" });
  }
  const assignment = await model.getBusinessPackEntitlement({
    companyId,
    targetUserId,
    packId,
  });
  res.json({ assignment });
});

export const setBusinessPackEntitlement = asyncHandler(async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const targetUserId = clean(req.params.userId);
  const payload = req.body?.assignment ?? req.body ?? {};
  const companyId = clean(payload.companyId);
  const packId = clean(payload.packId);
  const roleKey = payload.roleKey === null || payload.roleKey === ""
    ? null
    : clean(payload.roleKey);
  if (!targetUserId || !companyId || !packId) {
    return res.status(400).json({ error: "companyId, userId and packId are required" });
  }
  const assignment = await model.setBusinessPackEntitlement({
    companyId,
    targetUserId,
    packId,
    roleKey,
    actorUserId: req.user.id,
  });
  res.json({ assignment });
});

