import { Router } from "express";
import { businessManagerIntegrationAuth } from "../middlewares/bmIntegrationAuth.js";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { searchKnowledge } from "../services/bm.studentAgency.service.js";

import { verifyStudentSources } from "../services/bm.studentVerification.service.js";

import { compareStudentRules } from "../services/bm.studentComparison.service.js";

import * as consultations from "../services/bm.studentConsultation.service.js";

const router = Router();
router.get("/bm/student-agency/consultation-slots", businessManagerIntegrationAuth,
  asyncHandler(async(req,res)=>res.json(await consultations.listConsultations(req.user.companyId))));
router.post("/bm/student-agency/consultation-review", businessManagerIntegrationAuth,
  asyncHandler(async(req,res)=>res.json(await consultations.reviewConsultation(req.user.companyId,req.body))));
router.post("/bm/student-agency/consultation-bookings", businessManagerIntegrationAuth,
  asyncHandler(async(req,res)=>res.status(201).json(await consultations.bookConsultation(req.user.companyId,req.body))));
router.get("/bm/student-agency/consultation-bookings/:bookingId", businessManagerIntegrationAuth,
  asyncHandler(async(req,res)=>res.json(await consultations.getConsultation(req.user.companyId,req.params.bookingId))));
router.post("/bm/student-agency/consultation-bookings/:bookingId/review-email", businessManagerIntegrationAuth,
  asyncHandler(async(req,res)=>res.json(await consultations.reviewResend(req.user.companyId,req.params.bookingId,req.body))));
router.post("/bm/student-agency/consultation-bookings/:bookingId/email", businessManagerIntegrationAuth,
  asyncHandler(async(req,res)=>res.json(await consultations.resendConsultation(req.user.companyId,req.params.bookingId,req.body))));
router.get("/bm/student-agency/compare", businessManagerIntegrationAuth,
  asyncHandler(async (req, res) => res.json(await compareStudentRules(req.user.companyId, req.query))));
router.get("/bm/student-agency/verify", businessManagerIntegrationAuth,
  asyncHandler(async (req, res) => res.json(await verifyStudentSources(req.query))));
router.get("/bm/student-agency/knowledge", businessManagerIntegrationAuth,
  asyncHandler(async (req, res) => res.json(await searchKnowledge(req.user.companyId, req.query))));
export default router;
