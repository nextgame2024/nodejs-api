import { fetchPlanningData } from "../services/planningData.service.js";
import { genPreAssessmentSummary } from "../services/gemini-planner.js";
import {
  createPreAssessment,
  getPreAssessmentById,
  listPreAssessmentsForUser,
} from "../models/planner.model.js";
import { putToS3 } from "../services/s3.js";
import PDFDocument from "pdfkit";
import streamBuffers from "stream-buffers";

function buildPdfFromSummary({ siteInput, planningData, summary }) {
  const doc = new PDFDocument({ margin: 40 });
  const writableStreamBuffer = new streamBuffers.WritableStreamBuffer();

  doc.pipe(writableStreamBuffer);

  doc.fontSize(18).text("Brisbane Town Planner - Pre-Assessment Summary", {
    align: "center",
  });
  doc.moveDown();

  doc.fontSize(12).text(`Address: ${siteInput.address}`);
  doc.text(`Lot/Plan: ${siteInput.lotPlan || "N/A"}`);
  doc.text(`Site Area: ${siteInput.siteArea} m²`);
  doc.moveDown();

  // sections from Gemini summary
  for (const section of summary.sections) {
    doc.fontSize(14).text(section.title, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).text(section.body, { align: "left" });
    doc.moveDown();
  }

  doc.end();

  return new Promise((resolve, reject) => {
    writableStreamBuffer.on("finish", () =>
      resolve(writableStreamBuffer.getBuffer())
    );
    writableStreamBuffer.on("error", reject);
  });
}

export async function createPreAssessmentHandler(req, res, next) {
  try {
    const userId = req.user.id;

    const siteInput = req.body.site; // { address, lotPlan, siteArea, frontage, ... }
    const proposalInput = req.body.proposal; // { dimensions, setbacks, purpose, ... }

    if (!siteInput?.address) {
      return res
        .status(400)
        .json({ errors: { address: "Address is required" } });
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

    const pdfBuffer = await buildPdfFromSummary({
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
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function getPreAssessmentHandler(req, res, next) {
  try {
    const record = await getPreAssessmentById(req.params.id, req.user.id);
    if (!record) {
      return res.status(404).json({ message: "Pre-assessment not found" });
    }
    res.json({ preAssessment: record });
  } catch (err) {
    next(err);
  }
}

export async function listPreAssessmentsHandler(req, res, next) {
  try {
    const records = await listPreAssessmentsForUser(req.user.id);
    res.json({ preAssessments: records });
  } catch (err) {
    next(err);
  }
}
