import express from "express";
import {
  createReportRequestV2Controller,
  getReportByTokenV2Controller,
  suggestAddresses_v2,
  placeDetails_v2,
  generateReportV2Controller,
} from "../controllers/townplanner_v2.controller.js";

const router = express.Router();

router.post("/report-request", createReportRequestV2Controller);
router.get("/report/:token", getReportByTokenV2Controller);
router.post("/report-generate", generateReportV2Controller);
router.get("/suggest", suggestAddresses_v2);
router.get("/place-details", placeDetails_v2);

export default router;
