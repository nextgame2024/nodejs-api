import * as model from "../models/bm.project.types.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listProjectTypes(companyId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [projectTypes, total] = await Promise.all([
    model.listProjectTypes(companyId, { q, status, limit: safeLimit, offset }),
    model.countProjectTypes(companyId, { q, status }),
  ]);

  return { projectTypes, page: safePage, limit: safeLimit, total };
}

export const getProjectType = (companyId, projectTypeId) =>
  model.getProjectType(companyId, projectTypeId);
export const createProjectType = (companyId, userId, payload) =>
  model.createProjectType(companyId, userId, payload);
export const updateProjectType = (companyId, projectTypeId, payload) =>
  model.updateProjectType(companyId, projectTypeId, payload);
export const archiveProjectType = (companyId, projectTypeId) =>
  model.archiveProjectType(companyId, projectTypeId);

export async function listProjectTypeMaterials(companyId, projectTypeId) {
  const exists = await model.projectTypeExists(companyId, projectTypeId);
  if (!exists) return null;
  return model.listProjectTypeMaterials(companyId, projectTypeId);
}

export async function upsertProjectTypeMaterial(
  companyId,
  projectTypeId,
  materialId,
  payload,
) {
  return model.upsertProjectTypeMaterial(
    companyId,
    projectTypeId,
    materialId,
    payload,
  );
}

export const removeProjectTypeMaterial = (companyId, projectTypeId, materialId) =>
  model.removeProjectTypeMaterial(companyId, projectTypeId, materialId);

export async function listProjectTypeLabor(companyId, projectTypeId) {
  const exists = await model.projectTypeExists(companyId, projectTypeId);
  if (!exists) return null;
  return model.listProjectTypeLabor(companyId, projectTypeId);
}

export async function upsertProjectTypeLabor(
  companyId,
  projectTypeId,
  laborId,
  payload,
) {
  return model.upsertProjectTypeLabor(companyId, projectTypeId, laborId, payload);
}

export const removeProjectTypeLabor = (companyId, projectTypeId, laborId) =>
  model.removeProjectTypeLabor(companyId, projectTypeId, laborId);
