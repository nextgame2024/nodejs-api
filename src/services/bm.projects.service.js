import * as model from "../models/bm.projects.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listProjects(
  companyId,
  { q, status, clientId, page, limit }
) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [projects, total] = await Promise.all([
    model.listProjects(companyId, {
      q,
      status,
      clientId,
      limit: safeLimit,
      offset,
    }),
    model.countProjects(companyId, { q, status, clientId }),
  ]);

  return { projects, page: safePage, limit: safeLimit, total };
}

export const getProject = (companyId, projectId) =>
  model.getProject(companyId, projectId);
export const createProject = (companyId, userId, payload) =>
  model.createProject(companyId, userId, payload);
export const updateProject = (companyId, projectId, payload) =>
  model.updateProject(companyId, projectId, payload);
export const archiveProject = (companyId, projectId) =>
  model.archiveProject(companyId, projectId);

// Project materials
export async function listProjectMaterials(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.listProjectMaterials(companyId, projectId);
}

export const upsertProjectMaterial = (
  companyId,
  projectId,
  materialId,
  payload
) => model.upsertProjectMaterial(companyId, projectId, materialId, payload);

export const removeProjectMaterial = (companyId, projectId, materialId) =>
  model.removeProjectMaterial(companyId, projectId, materialId);

// Project labor
export async function listProjectLabor(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.listProjectLabor(companyId, projectId);
}

export const upsertProjectLabor = (companyId, projectId, laborId, payload) =>
  model.upsertProjectLabor(companyId, projectId, laborId, payload);

export const removeProjectLabor = (companyId, projectId, laborId) =>
  model.removeProjectLabor(companyId, projectId, laborId);
