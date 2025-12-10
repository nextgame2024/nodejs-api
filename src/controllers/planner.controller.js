// src/controllers/planner.controller.js
import axios from "axios";
import pgPkg from "pg";
import PDFDocument from "pdfkit";
import { randomUUID } from "crypto";

import { asyncHandler } from "../middlewares/asyncHandler.js";
import { fetchPlanningData } from "../services/planningData.service.js";
import { genPreAssessmentSummary } from "../services/gemini-planner.js";
import { putToS3 } from "../services/s3.js";
import { classifyDevelopment } from "../services/plannerClassification.service.js";

const { Pool } = pgPkg;

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST &&
    `postgres://${encodeURIComponent(
      process.env.DB_USER
    )}:${encodeURIComponent(process.env.DB_PASSWORD)}@${
      process.env.DB_HOST
    }:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE}`);

if (!connectionString) {
  console.warn(
    "[planner] No DATABASE_URL/DB_* configured – planner DB features will fail"
  );
}

const pool = connectionString ? new Pool({ connectionString }) : null;

const PDF_LOGO_URL =
  process.env.PDF_LOGO_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/sophiaAi-logo.png";

/**
 * Build a PDF in memory and resolve with a Buffer.
 * Now also includes classification info if provided.
 */
function buildPdfBuffer(options) {
  const site = options.site || {};
  const planning = options.planning || {};
  const proposal = options.proposal || {};
  const summary = options.summary || {};
  const classification = options.classification || null;
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

    // 5. Classification summary
    doc.fontSize(13).text("5. Likely development classification", {
      underline: true,
    });
    doc.moveDown(0.5);
    doc.fontSize(11);
    if (classification) {
      doc.text("Development type (guidance only): " + classification.devType);
      doc.text(
        "Likely assessment level (guidance only): " +
          classification.assessmentLevel
      );
      if (classification.reasoning) {
        doc.moveDown(0.5);
        doc.text(classification.reasoning, { align: "left" });
      }
    } else {
      doc.text(
        "Classification could not be determined from the available information."
      );
    }
    doc.moveDown();

    // 6. Assessment summary (Gemini or fallback)
    doc.fontSize(13).text("6. Assessment summary", { underline: true });
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
 *
 * Body:
 * {
 *   site: {...},
 *   proposal: {...},
 *   projectId?: number
 * }
 */
export const createPreAssessmentHandler = asyncHandler(async (req, res) => {
  if (!pool) {
    throw new Error("Planner DB is not configured");
  }

  // NOTE: user_id in planner_projects is BIGINT.
  // req.user.id may be a UUID string; only use it if it’s numeric.
  const rawUserId = req.user && req.user.id;
  const userId =
    rawUserId && !Number.isNaN(Number(rawUserId)) ? Number(rawUserId) : null;

  const body = req.body || {};
  const site = body.site || {};
  const proposal = body.proposal || {};
  const projectId = body.projectId || null;

  if (!site.address) {
    return res
      .status(400)
      .json({ error: "Site.address is required to create a pre-assessment" });
  }

  // 1) Get planning data (PostGIS lookups)
  const planning = await fetchPlanningData({
    address: site.address,
    lotPlan: site.lotPlan || null,
  });

  // 2) Classify development type & assessment level (Phase 2)
  const classification = classifyDevelopment({ site, proposal, planning });

  // 3) Generate summary via Gemini
  const summary = await genPreAssessmentSummary({
    site,
    planning,
    proposal,
    classification,
  });

  // 4) Load logo (optional)
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

  // 5) Build PDF
  const pdfBuffer = await buildPdfBuffer({
    site,
    planning,
    proposal,
    summary,
    classification,
    logoBuffer,
  });

  // 6) Upload PDF to S3
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

  // 7) Build pre-assessment metadata JSON
  const preAssessmentMeta = {
    pdfKey: key,
    pdfUrl: pdfUrl,
    summary: summary,
    classification: classification,
    createdAt: new Date().toISOString(),
  };

  // 8) Upsert project in DB: set dev_type + assessment_level from classification
  let projectRow;

  if (projectId) {
    const existingRes = await pool.query(
      "SELECT * FROM planner_projects WHERE id = $1 AND user_id = $2",
      [projectId, userId]
    );
    if (!existingRes.rows.length) {
      return res.status(404).json({ error: "Project not found" });
    }
    const existing = existingRes.rows[0];

    const updatedSiteJson =
      site && Object.keys(site).length ? site : existing.site_json || {};
    const updatedProposalJson =
      proposal && Object.keys(proposal).length
        ? proposal
        : existing.proposal_json || {};

    const updated = await pool.query(
      `UPDATE planner_projects
         SET address = COALESCE($1, address),
             lot_plan = COALESCE($2, lot_plan),
             site_json = $3,
             proposal_json = $4,
             planning_data_json = $5,
             pre_assessment_json = $6,
             dev_type = $7,
             assessment_level = $8,
             status = 'pre_assessment',
             updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        site.address || existing.address,
        site.lotPlan || existing.lot_plan,
        updatedSiteJson,
        updatedProposalJson,
        planning,
        preAssessmentMeta,
        classification.devType,
        classification.assessmentLevel,
        projectId,
      ]
    );
    projectRow = updated.rows[0];
  } else {
    const title =
      (proposal && proposal.purpose) ||
      site.address ||
      "Pre-assessment project";

    const inserted = await pool.query(
      `INSERT INTO planner_projects
         (user_id, title, address, lot_plan, site_json, proposal_json,
          planning_data_json, pre_assessment_json, dev_type, assessment_level, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pre_assessment')
       RETURNING *`,
      [
        userId,
        title,
        site.address || null,
        site.lotPlan || null,
        site,
        proposal,
        planning,
        preAssessmentMeta,
        classification.devType,
        classification.assessmentLevel,
      ]
    );
    projectRow = inserted.rows[0];
  }

  // 9) Store PDF document metadata
  await pool.query(
    `INSERT INTO planner_documents
       (project_id, type, s3_key, url, mime_type)
     VALUES ($1,$2,$3,$4,$5)`,
    [projectRow.id, "pre_assessment_pdf", key, pdfUrl, "application/pdf"]
  );

  const preAssessment = {
    id: key,
    projectId: projectRow.id,
    userId: userId,
    pdfKey: key,
    pdfUrl: pdfUrl,
    site: site,
    proposal: proposal,
    planningData: planning,
    summary: summary,
    classification: classification,
    createdAt: preAssessmentMeta.createdAt,
  };

  return res.status(201).json({
    project: projectRow,
    preAssessment: preAssessment,
  });
});
