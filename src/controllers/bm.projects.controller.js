import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.projects.service.js";
import * as docsService from "../services/bm.documents.service.js";

export const createDocumentFromProject = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId } = req.params;

  const payload = req.body?.document || req.body || {};
  const type = payload.type; // 'quote' | 'invoice'
  if (!type)
    return res.status(400).json({ error: "type is required (quote|invoice)" });

  const result = await docsService.createDocumentFromProject(
    userId,
    projectId,
    payload
  );
  if (!result) return res.status(404).json({ error: "Project not found" });

  // Return header + lines for immediate UI use
  res.status(201).json(result); // { document, materialLines, laborLines }
});

export const listProjects = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { q, status, clientId, page = "1", limit = "20" } = req.query;

  const result = await service.listProjects(userId, {
    q,
    status,
    clientId,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result); // { projects, page, limit, total }
});

export const getProject = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId } = req.params;
  const { includeLines = "false" } = req.query;

  const project = await service.getProject(userId, projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  if (includeLines === "true") {
    const [materials, labor] = await Promise.all([
      service.listProjectMaterials(userId, projectId),
      service.listProjectLabor(userId, projectId),
    ]);
    return res.json({ project, materials, labor });
  }

  res.json({ project });
});

export const createProject = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body?.project || req.body || {};

  if (!payload.client_id)
    return res.status(400).json({ error: "client_id is required" });
  if (!payload.project_name)
    return res.status(400).json({ error: "project_name is required" });

  const project = await service.createProject(userId, payload);
  if (!project) return res.status(404).json({ error: "Client not found" });

  res.status(201).json({ project });
});

export const updateProject = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId } = req.params;
  const payload = req.body?.project || req.body || {};

  const project = await service.updateProject(userId, projectId, payload);
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({ project });
});

export const archiveProject = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId } = req.params;

  const ok = await service.archiveProject(userId, projectId);
  if (!ok) return res.status(404).json({ error: "Project not found" });

  res.status(204).send();
});

// Materials
export const listProjectMaterials = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId } = req.params;

  const rows = await service.listProjectMaterials(userId, projectId);
  if (rows === null)
    return res.status(404).json({ error: "Project not found" });

  res.json({ materials: rows });
});

export const upsertProjectMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId, materialId } = req.params;
  const payload = req.body?.projectMaterial || req.body || {};

  const mId = materialId || payload.material_id;
  if (!mId) return res.status(400).json({ error: "material_id is required" });

  const row = await service.upsertProjectMaterial(
    userId,
    projectId,
    mId,
    payload
  );
  if (!row)
    return res
      .status(404)
      .json({ error: "Project not found or material not accessible" });

  res.status(201).json({ projectMaterial: row });
});

export const removeProjectMaterial = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId, materialId } = req.params;

  const ok = await service.removeProjectMaterial(userId, projectId, materialId);
  if (!ok) return res.status(404).json({ error: "Project material not found" });

  res.status(204).send();
});

// Labor
export const listProjectLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId } = req.params;

  const rows = await service.listProjectLabor(userId, projectId);
  if (rows === null)
    return res.status(404).json({ error: "Project not found" });

  res.json({ labor: rows });
});

export const upsertProjectLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId, laborId } = req.params;
  const payload = req.body?.projectLabor || req.body || {};

  const lId = laborId || payload.labor_id;
  if (!lId) return res.status(400).json({ error: "labor_id is required" });

  const row = await service.upsertProjectLabor(userId, projectId, lId, payload);
  if (!row)
    return res
      .status(404)
      .json({ error: "Project not found or labor not accessible" });

  res.status(201).json({ projectLabor: row });
});

export const removeProjectLabor = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { projectId, laborId } = req.params;

  const ok = await service.removeProjectLabor(userId, projectId, laborId);
  if (!ok) return res.status(404).json({ error: "Project labor not found" });

  res.status(204).send();
});
