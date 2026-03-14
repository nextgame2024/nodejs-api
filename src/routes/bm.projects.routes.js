import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  removeProject,
  listProjectMaterials,
  upsertProjectMaterial,
  removeProjectMaterial,
  listProjectLabor,
  upsertProjectLabor,
  removeProjectLabor,
  listProjectSurcharges,
  createProjectSurcharge,
  removeProjectSurcharge,
  getProjectSurchargeTransportationTime,
  getProjectSurchargeTransportationRoute,
  getProjectLaborExtras,
  upsertProjectLaborExtras,
  createDocumentFromProject,
} from "../controllers/bm.projects.controller.js";

const router = Router();

// Projects
router.get("/bm/projects", authRequired, listProjects);
router.post("/bm/projects", authRequired, createProject);
router.get("/bm/projects/:projectId", authRequired, getProject);
router.put("/bm/projects/:projectId", authRequired, updateProject);
router.delete("/bm/projects/:projectId", authRequired, removeProject);
router.post(
  "/bm/projects/:projectId/create-document",
  authRequired,
  createDocumentFromProject
);

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
router.get(
  "/bm/projects/:projectId/labor-extras",
  authRequired,
  getProjectLaborExtras
);
router.put(
  "/bm/projects/:projectId/labor-extras",
  authRequired,
  upsertProjectLaborExtras
);
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

// Project surcharges
router.get(
  "/bm/projects/:projectId/surcharges",
  authRequired,
  listProjectSurcharges
);
router.get(
  "/bm/projects/:projectId/surcharges/transportation-time",
  authRequired,
  getProjectSurchargeTransportationTime
);
router.get(
  "/bm/projects/:projectId/surcharges/transportation-route",
  authRequired,
  getProjectSurchargeTransportationRoute
);
router.post(
  "/bm/projects/:projectId/surcharges",
  authRequired,
  createProjectSurcharge
);
router.delete(
  "/bm/projects/:projectId/surcharges/:surchargeId",
  authRequired,
  removeProjectSurcharge
);

export default router;
