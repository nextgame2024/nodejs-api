import express from "express";
import {
  createReportRequestV2Controller,
  getReportByTokenV2Controller,
  suggestAddresses_v2,
  placeDetails_v2,
} from "../controllers/townplanner_v2.controller.js";

const router = express.Router();

// public endpoints for v2 flow
router.post("/report-request", createReportRequestV2Controller);
router.get("/report/:token", getReportByTokenV2Controller);
router.get("/suggest", suggestAddresses_v2);
router.get("/place-details", placeDetails_v2);

export default router;
