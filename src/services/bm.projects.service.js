// src/services/bm.projects.service.js
import * as model from "../models/bm.projects.model.js";
import { createDocumentFromProject as createDocFromProject } from "../models/bm.documents.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const toMoney = (value) => Math.round(Number(value) * 100) / 100;
const SURCHARGE_TYPES = new Set(["transportation", "other"]);

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

export const removeProject = async (companyId, projectId) => {
  const hasRelations = await model.projectHasRelations(companyId, projectId);
  if (hasRelations) {
    const ok = await model.archiveProject(companyId, projectId);
    return { ok, action: "archived" };
  }
  const ok = await model.deleteProject(companyId, projectId);
  return { ok, action: "deleted" };
};

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

// Project surcharges
export async function listProjectSurcharges(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.listProjectSurcharges(companyId, projectId);
}

export async function createProjectSurcharge(companyId, projectId, payload) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;

  const type = String(payload?.type || "")
    .trim()
    .toLowerCase();
  const name = String(payload?.name || "").trim();
  const cost = Number(payload?.cost);

  if (!type) {
    const err = new Error("type is required");
    err.status = 400;
    throw err;
  }
  if (!SURCHARGE_TYPES.has(type)) {
    const err = new Error("type must be transportation or other");
    err.status = 400;
    throw err;
  }
  if (!name) {
    const err = new Error("name is required");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(cost) || cost < 0) {
    const err = new Error("cost must be a valid non-negative number");
    err.status = 400;
    throw err;
  }

  return model.createProjectSurcharge(companyId, projectId, {
    type,
    name,
    cost: toMoney(cost),
  });
}

export const removeProjectSurcharge = (companyId, projectId, surchargeId) =>
  model.removeProjectSurcharge(companyId, projectId, surchargeId);

export async function getProjectLaborExtras(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.getProjectLaborExtras(companyId, projectId);
}

export async function upsertProjectLaborExtras(companyId, projectId, payload) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;

  const dailyRateRaw = payload?.daily_rate ?? payload?.dailyRate;
  const laborHoursRaw = payload?.labor_hours ?? payload?.laborHours;

  const dailyRate = Number(dailyRateRaw);
  const laborHours = Number(laborHoursRaw);

  if (!Number.isFinite(dailyRate) || dailyRate < 0) {
    const err = new Error("dailyRate must be a valid non-negative number");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(laborHours) || laborHours < 0) {
    const err = new Error("laborHours must be a valid non-negative number");
    err.status = 400;
    throw err;
  }

  return model.upsertProjectLaborExtras(companyId, projectId, {
    dailyRate: toMoney(dailyRate),
    laborHours: toMoney(laborHours),
  });
}

/**
 * Create a quote/invoice from a project using its materials/labor.
 * Delegates to bm.documents.model.js helper.
 */
export async function createDocumentFromProject(
  companyId,
  userId,
  projectId,
  payload
) {
  return createDocFromProject(companyId, userId, projectId, payload);
}
