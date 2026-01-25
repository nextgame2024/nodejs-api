import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.labor.service.js";

export const listLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listLabor(userId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result); // { labor, page, limit, total }
});

export const getLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { laborId } = req.params;

  const labor = await service.getLabor(userId, laborId);
  if (!labor) return res.status(404).json({ error: "Labor not found" });

  res.json({ labor });
});

export const createLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body?.labor || req.body || {};

  if (!payload.labor_name)
    return res.status(400).json({ error: "labor_name is required" });
  if (payload.unit_cost === undefined)
    return res.status(400).json({ error: "unit_cost is required" });

  const labor = await service.createLabor(userId, payload);
  res.status(201).json({ labor });
});

export const updateLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { laborId } = req.params;
  const payload = req.body?.labor || req.body || {};

  const labor = await service.updateLabor(userId, laborId, payload);
  if (!labor) return res.status(404).json({ error: "Labor not found" });

  res.json({ labor });
});

export const archiveLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { laborId } = req.params;

  const ok = await service.archiveLabor(userId, laborId);
  if (!ok) return res.status(404).json({ error: "Labor not found" });

  res.status(204).send();
});
