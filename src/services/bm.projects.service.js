import * as model from "../models/bm.projects.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listProjects(
  userId,
  { q, status, clientId, page, limit }
) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [projects, total] = await Promise.all([
    model.listProjects(userId, {
      q,
      status,
      clientId,
      limit: safeLimit,
      offset,
    }),
    model.countProjects(userId, { q, status, clientId }),
  ]);

  return { projects, page: safePage, limit: safeLimit, total };
}

export const getProject = (userId, projectId) =>
  model.getProject(userId, projectId);
export const createProject = (userId, payload) =>
  model.createProject(userId, payload);
export const updateProject = (userId, projectId, payload) =>
  model.updateProject(userId, projectId, payload);
export const archiveProject = (userId, projectId) =>
  model.archiveProject(userId, projectId);

export async function listProjectMaterials(userId, projectId) {
  const exists = await model.projectExists(userId, projectId);
  if (!exists) return null;
  return model.listProjectMaterials(userId, projectId);
}

export const upsertProjectMaterial = (userId, projectId, materialId, payload) =>
  model.upsertProjectMaterial(userId, projectId, materialId, payload);

export const removeProjectMaterial = (userId, projectId, materialId) =>
  model.removeProjectMaterial(userId, projectId, materialId);

export async function listProjectLabor(userId, projectId) {
  const exists = await model.projectExists(userId, projectId);
  if (!exists) return null;
  return model.listProjectLabor(userId, projectId);
}

export const upsertProjectLabor = (userId, projectId, laborId, payload) =>
  model.upsertProjectLabor(userId, projectId, laborId, payload);

export const removeProjectLabor = (userId, projectId, laborId) =>
  model.removeProjectLabor(userId, projectId, laborId);
