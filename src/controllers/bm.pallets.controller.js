import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.pallets.service.js";

function handleDomainError(err, res) {
  if (err?.status) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

export const getContext = asyncHandler(async (req, res) => {
  res.json(await service.getContext(req.user.companyId, req.user.id));
});

export const listOnSite = asyncHandler(async (req, res) => {
  const { q, page = "1", limit = "20" } = req.query;
  res.json(
    await service.listOnSite(req.user.companyId, {
      q,
      page: Number(page),
      limit: Number(limit),
    }),
  );
});

export const listSent = asyncHandler(async (req, res) => {
  const { page = "1", limit = "20" } = req.query;
  res.json(
    await service.listSent(req.user.companyId, req.user.id, {
      page: Number(page),
      limit: Number(limit),
    }),
  );
});

export const listIncoming = asyncHandler(async (req, res) => {
  const { page = "1", limit = "20" } = req.query;
  res.json(
    await service.listIncoming(req.user.companyId, req.user.id, {
      page: Number(page),
      limit: Number(limit),
    }),
  );
});

export const movePallets = asyncHandler(async (req, res) => {
  try {
    const movement = await service.movePallets(
      req.user.companyId,
      req.user.id,
      req.body?.movement || req.body || {},
    );
    res.status(201).json({ movement });
  } catch (err) {
    if (!handleDomainError(err, res)) throw err;
  }
});

export const deleteMovement = asyncHandler(async (req, res) => {
  const ok = await service.deleteMovement(
    req.user.companyId,
    req.user.id,
    req.params.palletId,
  );
  if (!ok) return res.status(404).json({ error: "Movement not found" });
  res.json({ palletId: req.params.palletId, action: "cancelled" });
});

export const receiveMovement = asyncHandler(async (req, res) => {
  const result = await service.receiveMovement(
    req.user.companyId,
    req.user.id,
    req.params.palletId,
  );
  if (!result) return res.status(404).json({ error: "Movement not found" });
  res.json(result);
});
