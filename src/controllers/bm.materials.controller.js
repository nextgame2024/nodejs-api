import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.materials.service.js";

export const listMaterials = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listMaterials(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { materialId } = req.params;

  const material = await service.getMaterial(companyId, materialId);
  if (!material) return res.status(404).json({ error: "Material not found" });

  res.json({ material });
});

export const createMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.material || req.body || {};

  if (!payload.material_name)
    return res.status(400).json({ error: "material_name is required" });
  if (typeof payload.code === "string" && !payload.code.trim()) {
    payload.code = null;
  }

  const material = await service.createMaterial(companyId, userId, payload);
  res.status(201).json({ material });
});

export const updateMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { materialId } = req.params;
  const payload = req.body?.material || req.body || {};
  if (typeof payload.code === "string" && !payload.code.trim()) {
    payload.code = null;
  }

  const material = await service.updateMaterial(companyId, materialId, payload);
  if (!material) return res.status(404).json({ error: "Material not found" });

  res.json({ material });
});

export const removeMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { materialId } = req.params;

  const result = await service.removeMaterial(companyId, materialId);
  if (!result?.ok) return res.status(404).json({ error: "Material not found" });

  res.json({ materialId, action: result.action });
});
