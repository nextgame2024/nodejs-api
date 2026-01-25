import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.materials.service.js";

export const listMaterials = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listMaterials(userId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { materialId } = req.params;

  const material = await service.getMaterial(userId, materialId);
  if (!material) return res.status(404).json({ error: "Material not found" });

  res.json({ material });
});

export const createMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body?.material || req.body || {};

  if (!payload.material_name)
    return res.status(400).json({ error: "material_name is required" });
  if (payload.unit_cost === undefined)
    return res.status(400).json({ error: "unit_cost is required" });

  const material = await service.createMaterial(userId, payload);
  res.status(201).json({ material });
});

export const updateMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { materialId } = req.params;
  const payload = req.body?.material || req.body || {};

  const material = await service.updateMaterial(userId, materialId, payload);
  if (!material) return res.status(404).json({ error: "Material not found" });

  res.json({ material });
});

export const archiveMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { materialId } = req.params;

  const ok = await service.archiveMaterial(userId, materialId);
  if (!ok) return res.status(404).json({ error: "Material not found" });

  res.status(204).send();
});
