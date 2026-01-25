import * as model from "../models/bm.labor.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listLabor(userId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [labor, total] = await Promise.all([
    model.listLabor(userId, { q, status, limit: safeLimit, offset }),
    model.countLabor(userId, { q, status }),
  ]);

  return { labor, page: safePage, limit: safeLimit, total };
}

export const getLabor = (userId, laborId) => model.getLabor(userId, laborId);
export const createLabor = (userId, payload) =>
  model.createLabor(userId, payload);
export const updateLabor = (userId, laborId, payload) =>
  model.updateLabor(userId, laborId, payload);
export const archiveLabor = (userId, laborId) =>
  model.archiveLabor(userId, laborId);
