import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import { createPreAssessmentHandler } from "../controllers/planner.controller.js";

const router = Router();

router.post(
  "/planner/pre-assessments",
  authRequired,
  createPreAssessmentHandler
);

export default router;
