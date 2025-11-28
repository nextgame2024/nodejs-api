import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  createPreAssessmentHandler,
  getPreAssessmentHandler,
  listPreAssessmentsHandler,
} from "../controllers/planner.controller.js";

const router = Router();

router.post(
  "/planner/pre-assessments",
  authRequired,
  createPreAssessmentHandler
);
router.get("/planner/pre-assessments", authRequired, listPreAssessmentsHandler);
router.get(
  "/planner/pre-assessments/:id",
  authRequired,
  getPreAssessmentHandler
);

export default router;
