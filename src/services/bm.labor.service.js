import * as model from "../models/bm.labor.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listLabor(companyId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [labor, total] = await Promise.all([
    model.listLabor(companyId, { q, status, limit: safeLimit, offset }),
    model.countLabor(companyId, { q, status }),
  ]);

  return { labor, page: safePage, limit: safeLimit, total };
}

export const getLabor = (companyId, laborId) =>
  model.getLabor(companyId, laborId);
export const createLabor = (companyId, userId, payload) =>
  model.createLabor(companyId, userId, payload);
export const updateLabor = (companyId, laborId, payload) =>
  model.updateLabor(companyId, laborId, payload);

export const removeLabor = async (companyId, laborId) => {
  const hasRelations = await model.laborHasRelations(companyId, laborId);
  if (hasRelations) {
    const ok = await model.archiveLabor(companyId, laborId);
    return { ok, action: "archived" };
  }
  const ok = await model.deleteLabor(companyId, laborId);
  return { ok, action: "deleted" };
};
