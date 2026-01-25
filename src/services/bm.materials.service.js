import * as model from "../models/bm.materials.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listMaterials(userId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [materials, total] = await Promise.all([
    model.listMaterials(userId, { q, status, limit: safeLimit, offset }),
    model.countMaterials(userId, { q, status }),
  ]);

  return { materials, page: safePage, limit: safeLimit, total };
}

export const getMaterial = (userId, materialId) =>
  model.getMaterial(userId, materialId);
export const createMaterial = (userId, payload) =>
  model.createMaterial(userId, payload);
export const updateMaterial = (userId, materialId, payload) =>
  model.updateMaterial(userId, materialId, payload);
export const archiveMaterial = (userId, materialId) =>
  model.archiveMaterial(userId, materialId);
