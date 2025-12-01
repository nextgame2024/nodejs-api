import { asyncHandler } from "../middlewares/asyncHandler.js";
import { fetchPlanningData } from "../services/planningData.service.js";
import { genPreAssessmentSummary } from "../services/gemini-planner.js";
import { putToS3 } from "../services/s3.js";
import PDFDocument from "pdfkit";
import { randomUUID } from "crypto";

/**
 * Build a PDF in memory and resolve with a Buffer.
 */
function buildPdfBuffer({ site, planning, proposal, summary }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    // ---- PDF CONTENT ----
    doc.fontSize(18).text("Brisbane Town Planner – Pre-Assessment Summary", {
      align: "center",
    });
    doc.moveDown();

    // Site
    doc.fontSize(13).text("1. Site details", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11);
    doc.text(`Address: ${site.address || "-"}`);
    doc.text(`Lot / Plan: ${site.lotPlan || "-"}`);
    if (site.siteArea) doc.text(`Site area: ${site.siteArea} m²`);
    if (site.frontage) doc.text(`Frontage: ${site.frontage} m`);
    doc.moveDown();

    // Planning
    doc.fontSize(13).text("2. Planning context", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11);
    doc.text(`Zoning: ${planning.zoning || "-"}`);
    if (planning.neighbourhoodPlan) {
      doc.text(`Neighbourhood plan: ${planning.neighbourhoodPlan}`);
    }
    if (Array.isArray(planning.overlays) && planning.overlays.length) {
      doc.text(
        "Overlays: " +
          planning.overlays
            .map((o) => (o.severity ? `${o.name} (${o.severity})` : o.name))
            .join(", ")
      );
    }
    doc.moveDown();

    // Shed / proposal
    doc.fontSize(13).text("3. Proposal – domestic outbuilding", {
      underline: true,
    });
    doc.moveDown(0.5);
    doc.fontSize(11);
    if (proposal.lengthM && proposal.widthM) {
      doc.text(`Dimensions: ${proposal.lengthM} m × ${proposal.widthM} m`);
    }
    if (proposal.heightRidgeM) {
      doc.text(`Ridge height: ${proposal.heightRidgeM} m`);
    }
    if (proposal.heightWallM) {
      doc.text(`Wall height: ${proposal.heightWallM} m`);
    }
    if (proposal.materials) {
      doc.text(`Materials: ${proposal.materials}`);
    }
    if (proposal.purpose) {
      doc.text(`Purpose: ${proposal.purpose}`);
    }

    doc.moveDown();
    doc.fontSize(13).text("4. Setbacks", { underline: true });
    doc.moveDown(0.5);
    const s = proposal.setbacks || {};
    doc.fontSize(11);
    doc.text(`Front: ${s.front ?? "-"} m`);
    doc.text(`Side 1: ${s.side1 ?? "-"} m`);
    doc.text(`Side 2: ${s.side2 ?? "-"} m`);
    doc.text(`Rear: ${s.rear ?? "-"} m`);

    doc.moveDown();
    doc.fontSize(13).text("5. Assessment summary", { underline: true });
    doc.moveDown(0.5);

    if (summary?.sections?.length) {
      summary.sections.forEach((section, idx) => {
        if (idx > 0) {
          doc.addPage();
        }
        doc.fontSize(14).text(section.title, { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(11).text(section.body || "", {
          align: "left",
        });
      });
    } else {
      doc
        .fontSize(11)
        .text(
          "No detailed summary was generated. This document is an initial pre-assessment only.",
          { align: "left" }
        );
    }

    doc.end();
  });
}

/**
 * POST /api/planner/pre-assessments
 */
export const createPreAssessment = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  const { site = {}, proposal = {} } = req.body || {};

  if (!site.address) {
    return res
      .status(400)
      .json({ error: "Site.address is required to create a pre-assessment" });
  }

  // 1) Planning data (geocode + zoning from GeoJSON, etc.)
  const planning = await fetchPlanningData({
    address: site.address,
    lotPlan: site.lotPlan || null,
  });

  // 2) Gemini (with fallback inside the service)
  const summary = await genPreAssessmentSummary({ site, planning, proposal });

  // 3) Build PDF
  const pdfBuffer = await buildPdfBuffer({
    site,
    planning,
    proposal,
    summary,
  });

  // 4) Upload PDF to S3
  const key = `pre-assessments/${userId || "anon"}/${Date.now()}-${randomUUID()}.pdf`;

  const pdfUrl = await putToS3({
    key,
    body: pdfBuffer,
    contentType: "application/pdf",
  });

  const preAssessment = {
    id: key,
    userId,
    pdfKey: key,
    pdfUrl,
    site,
    proposal,
    planningData: planning,
    summary,
    createdAt: new Date().toISOString(),
  };

  // TODO: later – persist preAssessment metadata to DB.

  return res.status(201).json({ preAssessment });
});
