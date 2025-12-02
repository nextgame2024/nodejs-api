import axios from "axios";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { fetchPlanningData } from "../services/planningData.service.js";
import { genPreAssessmentSummary } from "../services/gemini-planner.js";
import { putToS3 } from "../services/s3.js";
import PDFDocument from "pdfkit";
import { randomUUID } from "crypto";

const PDF_LOGO_URL =
  process.env.PDF_LOGO_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/sophiaAi-logo.png";

/**
 * Build a PDF in memory and resolve with a Buffer.
 */
function buildPdfBuffer(options) {
  const site = options.site || {};
  const planning = options.planning || {};
  const proposal = options.proposal || {};
  const summary = options.summary || {};
  const logoBuffer = options.logoBuffer || null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    // ---- HEADER / LOGO ----
    if (logoBuffer) {
      try {
        // Place logo at top-left
        doc.image(logoBuffer, doc.page.margins.left, 24, { width: 120 });
        doc.moveDown(2.5);
      } catch (err) {
        console.error(
          "[planner] Failed to render logo into PDF:",
          (err && err.message) || err
        );
        doc.moveDown();
      }
    }

    // ---- TITLE ----
    doc.fontSize(18).text("Brisbane Town Planner – Pre-Assessment Summary", {
      align: "center",
    });
    doc.moveDown();

    // 1. Site details
    doc.fontSize(13).text("1. Site details", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11);
    doc.text("Address: " + (site.address || "-"));
    doc.text("Lot / Plan: " + (site.lotPlan || "-"));
    if (site.siteArea) {
      doc.text("Site area: " + site.siteArea + " m²");
    }
    if (site.frontage) {
      doc.text("Frontage: " + site.frontage + " m");
    }
    if (typeof site.cornerLot === "boolean") {
      doc.text("Corner lot: " + (site.cornerLot ? "Yes" : "No"));
    }
    doc.moveDown();

    // 2. Planning context
    doc.fontSize(13).text("2. Planning context", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11);
    doc.text("Zoning: " + (planning.zoning || "-"));
    if (planning.neighbourhoodPlan) {
      doc.text("Neighbourhood plan: " + planning.neighbourhoodPlan);
    }
    if (Array.isArray(planning.overlays) && planning.overlays.length > 0) {
      const overlayText = planning.overlays
        .map(function (o) {
          if (o.severity) {
            return o.name + " (" + o.severity + ")";
          }
          return o.name;
        })
        .join(", ");
      doc.text("Overlays: " + overlayText);
    }
    if (planning.hasTransportNoiseCorridor) {
      doc.text("Transport noise corridor: Site is affected or nearby.");
    }
    doc.moveDown();

    // 3. Proposal
    doc.fontSize(13).text("3. Proposal – domestic outbuilding", {
      underline: true,
    });
    doc.moveDown(0.5);
    doc.fontSize(11);

    if (proposal.lengthM && proposal.widthM) {
      doc.text(
        "Dimensions: " + proposal.lengthM + " m × " + proposal.widthM + " m"
      );
    }
    if (proposal.heightRidgeM) {
      doc.text("Ridge height: " + proposal.heightRidgeM + " m");
    }
    if (proposal.heightWallM) {
      doc.text("Wall height: " + proposal.heightWallM + " m");
    }
    if (proposal.materials) {
      doc.text("Materials: " + proposal.materials);
    }
    if (proposal.purpose) {
      doc.text("Purpose: " + proposal.purpose);
    }
    if (proposal.stormwater) {
      doc.text("Stormwater: " + proposal.stormwater);
    }
    if (proposal.earthworks) {
      doc.text("Earthworks: " + proposal.earthworks);
    }
    if (typeof proposal.existingBuildingsAffected === "boolean") {
      doc.text(
        "Existing buildings affected: " +
          (proposal.existingBuildingsAffected ? "Yes" : "No")
      );
    }
    if (typeof proposal.replacement === "boolean") {
      doc.text(
        "Replacement of existing structure: " +
          (proposal.replacement ? "Yes" : "No")
      );
    }

    doc.moveDown();

    // 4. Setbacks
    doc.fontSize(13).text("4. Setbacks", { underline: true });
    doc.moveDown(0.5);
    const s = proposal.setbacks || {};
    doc.fontSize(11);
    doc.text("Front: " + (s.front != null ? s.front : "-") + " m");
    doc.text("Side 1: " + (s.side1 != null ? s.side1 : "-") + " m");
    doc.text("Side 2: " + (s.side2 != null ? s.side2 : "-") + " m");
    doc.text("Rear: " + (s.rear != null ? s.rear : "-") + " m");
    doc.moveDown();

    // 5. Assessment summary (from Gemini or fallback)
    doc.fontSize(13).text("5. Assessment summary", { underline: true });
    doc.moveDown(0.5);

    const sections =
      summary && Array.isArray(summary.sections) ? summary.sections : [];

    if (sections.length > 0) {
      sections.forEach(function (section, idx) {
        if (idx > 0) {
          doc.addPage();
        }
        doc.fontSize(14).text(section.title || "Section", { underline: true });
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
 * Main handler used by the Angular planner.
 */
export const createPreAssessmentHandler = asyncHandler(async (req, res) => {
  const userId = (req.user && req.user.id) || null;
  const body = req.body || {};
  const site = body.site || {};
  const proposal = body.proposal || {};

  if (!site.address) {
    return res
      .status(400)
      .json({ error: "Site.address is required to create a pre-assessment" });
  }

  // 1) Get planning data (geocode + zoning + overlays lookups)
  const planning = await fetchPlanningData({
    address: site.address,
    lotPlan: site.lotPlan || null,
  });

  // 2) Generate summary via Gemini (with internal fallback)
  const summary = await genPreAssessmentSummary({ site, planning, proposal });

  // 3) Load logo (optional)
  let logoBuffer = null;
  try {
    const resp = await axios.get(PDF_LOGO_URL, {
      responseType: "arraybuffer",
    });
    logoBuffer = Buffer.from(resp.data);
  } catch (err) {
    console.error(
      "[planner] Could not load PDF logo:",
      (err && err.message) || err
    );
  }

  // 4) Build PDF
  const pdfBuffer = await buildPdfBuffer({
    site,
    planning,
    proposal,
    summary,
    logoBuffer,
  });

  // 5) Upload PDF to S3
  const key =
    "pre-assessments/" +
    (userId || "anon") +
    "/" +
    Date.now() +
    "-" +
    randomUUID() +
    ".pdf";

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

  return res.status(201).json({ preAssessment });
});

// NOTE: no other exports for now – list/get can be added later when needed.
