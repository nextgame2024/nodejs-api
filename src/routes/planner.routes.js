import { Router } from "express";
import auth from "../middlewares/auth.js";
import {
  createPreAssessmentHandler,
  getPreAssessmentHandler,
  listPreAssessmentsHandler,
} from "../controllers/planner.controller.js";

const router = Router();

router.post("/planner/pre-assessments", auth, createPreAssessmentHandler);
router.get("/planner/pre-assessments", auth, listPreAssessmentsHandler);
router.get("/planner/pre-assessments/:id", auth, getPreAssessmentHandler);

export default router;
