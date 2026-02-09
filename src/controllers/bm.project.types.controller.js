import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.project.types.service.js";

export const listProjectTypes = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listProjectTypes(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getProjectType = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId } = req.params;

  const projectType = await service.getProjectType(companyId, projectTypeId);
  if (!projectType)
    return res.status(404).json({ error: "Project type not found" });

  res.json({ projectType });
});

export const createProjectType = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.projectType || req.body || {};

  if (!payload.name) {
    return res.status(400).json({ error: "name is required" });
  }

  const projectType = await service.createProjectType(
    companyId,
    userId,
    payload,
  );
  res.status(201).json({ projectType });
});

export const updateProjectType = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId } = req.params;
  const payload = req.body?.projectType || req.body || {};

  const projectType = await service.updateProjectType(
    companyId,
    projectTypeId,
    payload,
  );
  if (!projectType)
    return res.status(404).json({ error: "Project type not found" });

  res.json({ projectType });
});

export const removeProjectType = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId } = req.params;

  const result = await service.removeProjectType(companyId, projectTypeId);
  if (!result?.ok)
    return res.status(404).json({ error: "Project type not found" });

  res.json({ projectTypeId, action: result.action });
});

export const listProjectTypeMaterials = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId } = req.params;

  const materials = await service.listProjectTypeMaterials(
    companyId,
    projectTypeId,
  );
  if (!materials)
    return res.status(404).json({ error: "Project type not found" });

  res.json({ materials });
});

export const addProjectTypeMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId } = req.params;
  const payload = req.body?.projectTypeMaterial || req.body || {};
  const materialId = payload.material_id ?? payload.materialId;

  if (!materialId) {
    return res.status(400).json({ error: "material_id is required" });
  }

  const projectTypeMaterial = await service.upsertProjectTypeMaterial(
    companyId,
    projectTypeId,
    materialId,
    payload,
  );
  if (!projectTypeMaterial)
    return res.status(404).json({ error: "Project type not found" });

  res.status(201).json({ projectTypeMaterial });
});

export const updateProjectTypeMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId, materialId } = req.params;
  const payload = req.body?.projectTypeMaterial || req.body || {};

  const projectTypeMaterial = await service.upsertProjectTypeMaterial(
    companyId,
    projectTypeId,
    materialId,
    payload,
  );
  if (!projectTypeMaterial)
    return res.status(404).json({ error: "Project type not found" });

  res.json({ projectTypeMaterial });
});

export const removeProjectTypeMaterial = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId, materialId } = req.params;

  const ok = await service.removeProjectTypeMaterial(
    companyId,
    projectTypeId,
    materialId,
  );
  if (!ok)
    return res.status(404).json({ error: "Project type material not found" });

  res.status(204).send();
});

export const listProjectTypeLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId } = req.params;

  const labor = await service.listProjectTypeLabor(companyId, projectTypeId);
  if (!labor)
    return res.status(404).json({ error: "Project type not found" });

  res.json({ labor });
});

export const addProjectTypeLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId } = req.params;
  const payload = req.body?.projectTypeLabor || req.body || {};
  const laborId = payload.labor_id ?? payload.laborId;

  if (!laborId) {
    return res.status(400).json({ error: "labor_id is required" });
  }

  const projectTypeLabor = await service.upsertProjectTypeLabor(
    companyId,
    projectTypeId,
    laborId,
    payload,
  );
  if (!projectTypeLabor)
    return res.status(404).json({ error: "Project type not found" });

  res.status(201).json({ projectTypeLabor });
});

export const updateProjectTypeLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId, laborId } = req.params;
  const payload = req.body?.projectTypeLabor || req.body || {};

  const projectTypeLabor = await service.upsertProjectTypeLabor(
    companyId,
    projectTypeId,
    laborId,
    payload,
  );
  if (!projectTypeLabor)
    return res.status(404).json({ error: "Project type not found" });

  res.json({ projectTypeLabor });
});

export const removeProjectTypeLabor = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { projectTypeId, laborId } = req.params;

  const ok = await service.removeProjectTypeLabor(
    companyId,
    projectTypeId,
    laborId,
  );
  if (!ok)
    return res.status(404).json({ error: "Project type labor not found" });

  res.status(204).send();
});
