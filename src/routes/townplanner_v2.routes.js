import express from "express";
import {
  createReportRequestV2Controller,
  getReportByTokenV2Controller,
} from "../controllers/townplanner_v2.controller.js";

const router = express.Router();

// public endpoints for v2 flow
router.post("/report-request", createReportRequestV2Controller);
router.get("/report/:token", getReportByTokenV2Controller);

export default router;
