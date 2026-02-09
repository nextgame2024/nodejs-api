import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.labor.service.js";

export const listLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listLabor(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { laborId } = req.params;

  const labor = await service.getLabor(companyId, laborId);
  if (!labor) return res.status(404).json({ error: "Labor not found" });

  res.json({ labor });
});

export const createLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.labor || req.body || {};

  if (!payload.labor_name)
    return res.status(400).json({ error: "labor_name is required" });
  if (payload.unit_cost === undefined)
    return res.status(400).json({ error: "unit_cost is required" });

  const labor = await service.createLabor(companyId, userId, payload);
  res.status(201).json({ labor });
});

export const updateLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { laborId } = req.params;
  const payload = req.body?.labor || req.body || {};

  const labor = await service.updateLabor(companyId, laborId, payload);
  if (!labor) return res.status(404).json({ error: "Labor not found" });

  res.json({ labor });
});

export const removeLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { laborId } = req.params;

  const result = await service.removeLabor(companyId, laborId);
  if (!result?.ok) return res.status(404).json({ error: "Labor not found" });

  res.json({ laborId, action: result.action });
});
