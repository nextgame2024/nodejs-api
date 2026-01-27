import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.projects.service.js";

export const listProjects = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, clientId, page = "1", limit = "20" } = req.query;

  const result = await service.listProjects(companyId, {
    q,
    status,
    clientId,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const project = await service.getProject(companyId, projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({ project });
});

export const createProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.project || req.body || {};

  if (!payload.client_id)
    return res.status(400).json({ error: "client_id is required" });
  if (!payload.project_name)
    return res.status(400).json({ error: "project_name is required" });

  const project = await service.createProject(companyId, userId, payload);
  if (!project) return res.status(404).json({ error: "Client not found" });

  res.status(201).json({ project });
});

export const updateProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;
  const payload = req.body?.project || req.body || {};

  const project = await service.updateProject(companyId, projectId, payload);
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({ project });
});

export const archiveProject = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const ok = await service.archiveProject(companyId, projectId);
  if (!ok) return res.status(404).json({ error: "Project not found" });

  res.status(204).send();
});

// Materials
export const listProjectMaterials = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const materials = await service.listProjectMaterials(companyId, projectId);
  if (materials === null)
    return res.status(404).json({ error: "Project not found" });

  res.json({ materials });
});

export const upsertProjectMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, materialId } = req.params;
  const payload = req.body?.projectMaterial || req.body || {};

  const row = await service.upsertProjectMaterial(
    companyId,
    projectId,
    materialId,
    payload
  );
  if (!row)
    return res.status(404).json({ error: "Project/material not accessible" });

  res.json({ projectMaterial: row });
});

export const removeProjectMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, materialId } = req.params;

  const ok = await service.removeProjectMaterial(
    companyId,
    projectId,
    materialId
  );
  if (!ok) return res.status(404).json({ error: "Project material not found" });

  res.status(204).send();
});

// Labor
export const listProjectLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId } = req.params;

  const labor = await service.listProjectLabor(companyId, projectId);
  if (labor === null)
    return res.status(404).json({ error: "Project not found" });

  res.json({ labor });
});

export const upsertProjectLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, laborId } = req.params;
  const payload = req.body?.projectLabor || req.body || {};

  const row = await service.upsertProjectLabor(
    companyId,
    projectId,
    laborId,
    payload
  );
  if (!row)
    return res.status(404).json({ error: "Project/labor not accessible" });

  res.json({ projectLabor: row });
});

export const removeProjectLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectId, laborId } = req.params;

  const ok = await service.removeProjectLabor(companyId, projectId, laborId);
  if (!ok) return res.status(404).json({ error: "Project labor not found" });

  res.status(204).send();
});
