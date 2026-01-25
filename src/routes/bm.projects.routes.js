import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  listProjectMaterials,
  upsertProjectMaterial,
  removeProjectMaterial,
  listProjectLabor,
  upsertProjectLabor,
  removeProjectLabor,
} from "../controllers/bm.projects.controller.js";

const router = Router();

// Projects
router.get("/bm/projects", authRequired, listProjects);
router.post("/bm/projects", authRequired, createProject);
router.get("/bm/projects/:projectId", authRequired, getProject);
router.put("/bm/projects/:projectId", authRequired, updateProject);
router.delete("/bm/projects/:projectId", authRequired, archiveProject);

// Project materials (PK: project_id + material_id)
router.get(
  "/bm/projects/:projectId/materials",
  authRequired,
  listProjectMaterials
);
router.post(
  "/bm/projects/:projectId/materials",
  authRequired,
  upsertProjectMaterial
);
router.put(
  "/bm/projects/:projectId/materials/:materialId",
  authRequired,
  upsertProjectMaterial
);
router.delete(
  "/bm/projects/:projectId/materials/:materialId",
  authRequired,
  removeProjectMaterial
);

// Project labor (PK: project_id + labor_id)
router.get("/bm/projects/:projectId/labor", authRequired, listProjectLabor);
router.post("/bm/projects/:projectId/labor", authRequired, upsertProjectLabor);
router.put(
  "/bm/projects/:projectId/labor/:laborId",
  authRequired,
  upsertProjectLabor
);
router.delete(
  "/bm/projects/:projectId/labor/:laborId",
  authRequired,
  removeProjectLabor
);

export default router;
