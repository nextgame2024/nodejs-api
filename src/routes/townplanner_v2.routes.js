import express from "express";
import {
  createReportRequestV2Controller,
  getReportByTokenV2Controller,
  suggestAddresses_v2,
  placeDetails_v2,
  generateReportV2Controller,
} from "../controllers/townplanner_v2.controller.js";

const router = express.Router();

// Public endpoints for V2 flow
router.get("/suggest", suggestAddresses_v2);
router.get("/place-details", placeDetails_v2);

// Email flow (optional)
router.post("/report-request", createReportRequestV2Controller);

// Report generation (job-style) + polling
router.post("/report-generate", generateReportV2Controller);
router.get("/report/:token", getReportByTokenV2Controller);

export default router;
