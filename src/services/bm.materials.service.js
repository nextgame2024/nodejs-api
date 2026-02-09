import * as model from "../models/bm.materials.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listMaterials(companyId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [materials, total] = await Promise.all([
    model.listMaterials(companyId, { q, status, limit: safeLimit, offset }),
    model.countMaterials(companyId, { q, status }),
  ]);

  return { materials, page: safePage, limit: safeLimit, total };
}

export const getMaterial = (companyId, materialId) =>
  model.getMaterial(companyId, materialId);
export const createMaterial = (companyId, userId, payload) =>
  model.createMaterial(companyId, userId, payload);
export const updateMaterial = (companyId, materialId, payload) =>
  model.updateMaterial(companyId, materialId, payload);

export const removeMaterial = async (companyId, materialId) => {
  const hasRelations = await model.materialHasRelations(companyId, materialId);
  if (hasRelations) {
    const ok = await model.archiveMaterial(companyId, materialId);
    return { ok, action: "archived" };
  }
  const ok = await model.deleteMaterial(companyId, materialId);
  return { ok, action: "deleted" };
};
