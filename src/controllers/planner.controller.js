import PDFDocument from "pdfkit";
import streamBuffers from "stream-buffers";

import { asyncHandler } from "../middlewares/asyncHandler.js";
import { fetchPlanningData } from "../services/planningData.service.js";
import { genPreAssessmentSummary } from "../services/gemini-planner.js";
import {
  createPreAssessment,
  getPreAssessmentById,
  listPreAssessmentsForUser,
} from "../models/planner.model.js";
import { putToS3 } from "../services/s3.js";

function buildPdf({ siteInput, planningData, summary }) {
  const doc = new PDFDocument({ margin: 40 });
  const writable = new streamBuffers.WritableStreamBuffer();
  doc.pipe(writable);

  doc.fontSize(18).text("Brisbane Town Planner - Pre-Assessment Summary", {
    align: "center",
  });
  doc.moveDown();

  doc.fontSize(12).text(`Address: ${siteInput.address}`);
  if (siteInput.lotPlan) doc.text(`Lot/Plan: ${siteInput.lotPlan}`);
  if (siteInput.siteArea) doc.text(`Site Area: ${siteInput.siteArea} m²`);
  if (siteInput.frontage) doc.text(`Frontage: ${siteInput.frontage} m`);
  doc.moveDown();

  for (const section of summary.sections || []) {
    doc.fontSize(14).text(section.title, { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11).text(section.body || "", { align: "left" });
    doc.moveDown();
  }

  doc.end();

  return new Promise((resolve, reject) => {
    writable.on("finish", () => resolve(writable.getBuffer()));
    writable.on("error", reject);
  });
}

export const createPreAssessmentHandler = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const siteInput = req.body.site || {};
  const proposalInput = req.body.proposal || {};

  if (!siteInput.address) {
    return res.status(400).json({ error: "site.address is required" });
  }

  const planningData = await fetchPlanningData({
    address: siteInput.address,
    lotPlan: siteInput.lotPlan,
  });

  const geminiSummary = await genPreAssessmentSummary({
    site: siteInput,
    planning: planningData,
    proposal: proposalInput,
  });

  const pdfBuffer = await buildPdf({
    siteInput,
    planningData,
    summary: geminiSummary,
  });

  const pdfKey = `pre-assessments/${userId}/${Date.now()}.pdf`;
  const pdfUrl = await putToS3({
    key: pdfKey,
    body: pdfBuffer,
    contentType: "application/pdf",
  });

  const record = await createPreAssessment({
    userId,
    siteInput,
    planningData,
    geminiSummary,
    pdfUrl,
  });

  res.status(201).json({
    preAssessment: {
      id: record.id,
      pdfUrl: record.pdf_url,
      summary: geminiSummary,
      planningData,
      status: record.status,
      createdAt: record.created_at,
    },
  });
});

export const getPreAssessmentHandler = asyncHandler(async (req, res) => {
  const record = await getPreAssessmentById(req.params.id, req.user.id);
  if (!record)
    return res.status(404).json({ error: "Pre-assessment not found" });
  res.json({ preAssessment: record });
});

export const listPreAssessmentsHandler = asyncHandler(async (req, res) => {
  const rows = await listPreAssessmentsForUser(req.user.id);
  res.json({ preAssessments: rows });
});
