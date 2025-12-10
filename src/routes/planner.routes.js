import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import { createPreAssessmentHandler } from "../controllers/planner.controller.js";
import {
  listProjectsHandler,
  getProjectHandler,
} from "../controllers/plannerProjects.controller.js";

const router = Router();

router.post(
  "/planner/pre-assessments",
  authRequired,
  createPreAssessmentHandler
);

router.get("/planner/projects", authRequired, listProjectsHandler);
router.get("/planner/projects/:id", authRequired, getProjectHandler);

export default router;
