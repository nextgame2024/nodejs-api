import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listProjectTypes,
  getProjectType,
  createProjectType,
  updateProjectType,
  removeProjectType,
  listProjectTypeMaterials,
  addProjectTypeMaterial,
  updateProjectTypeMaterial,
  removeProjectTypeMaterial,
  listProjectTypeLabor,
  addProjectTypeLabor,
  updateProjectTypeLabor,
  removeProjectTypeLabor,
} from "../controllers/bm.project.types.controller.js";

const router = Router();

router.get("/bm/project-types", authRequired, listProjectTypes);
router.post("/bm/project-types", authRequired, createProjectType);
router.get("/bm/project-types/:projectTypeId", authRequired, getProjectType);
router.put("/bm/project-types/:projectTypeId", authRequired, updateProjectType);
router.delete(
  "/bm/project-types/:projectTypeId",
  authRequired,
  removeProjectType,
);

router.get(
  "/bm/project-types/:projectTypeId/materials",
  authRequired,
  listProjectTypeMaterials,
);
router.post(
  "/bm/project-types/:projectTypeId/materials",
  authRequired,
  addProjectTypeMaterial,
);
router.put(
  "/bm/project-types/:projectTypeId/materials/:materialId",
  authRequired,
  updateProjectTypeMaterial,
);
router.delete(
  "/bm/project-types/:projectTypeId/materials/:materialId",
  authRequired,
  removeProjectTypeMaterial,
);

router.get(
  "/bm/project-types/:projectTypeId/labor",
  authRequired,
  listProjectTypeLabor,
);
router.post(
  "/bm/project-types/:projectTypeId/labor",
  authRequired,
  addProjectTypeLabor,
);
router.put(
  "/bm/project-types/:projectTypeId/labor/:laborId",
  authRequired,
  updateProjectTypeLabor,
);
router.delete(
  "/bm/project-types/:projectTypeId/labor/:laborId",
  authRequired,
  removeProjectTypeLabor,
);

export default router;
