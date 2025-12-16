import axios from "axios";
import pgPkg from "pg";
import PDFDocument from "pdfkit";
import { randomUUID } from "crypto";

import { asyncHandler } from "../middlewares/asyncHandler.js";
import { fetchPlanningData } from "../services/planningData.service.js";
import { genPreAssessmentSummary } from "../services/gemini-planner.js";
import { putToS3 } from "../services/s3.js";
import { classifyDevelopment } from "../services/plannerClassification.service.js";
import { buildPreAssessmentChecks } from "../services/preAssessmentChecks.service.js";

const { Pool } = pgPkg;

const S3_PUBLIC_PREFIX = process.env.S3_PUBLIC_PREFIX || "public/";

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST &&
    `postgres://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(
      process.env.DB_PASSWORD
    )}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE}`);

if (!connectionString) {
  console.warn(
    "[planner] No DATABASE_URL/DB_* configured – planner DB features will fail"
  );
}

const pool = connectionString ? new Pool({ connectionString }) : null;

const PDF_LOGO_URL =
  process.env.PDF_LOGO_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/sophiaAi-logo.png";

const GOOGLE_STATIC_MAPS_URL = "https://maps.googleapis.com/maps/api/staticmap";

function safeText(v, fallback = "-") {
  const s = v == null ? "" : String(v).trim();
  return s ? s : fallback;
}

function isNum(v) {
  return v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));
}

function formatDateTime(d = new Date()) {
  return d.toLocaleString("en-AU", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pickParcelRing(geojson) {
  if (!geojson) return null;

  if (geojson.type === "Polygon" && Array.isArray(geojson.coordinates?.[0])) {
    return geojson.coordinates[0];
  }

  if (geojson.type === "MultiPolygon" && Array.isArray(geojson.coordinates)) {
    let best = null;
    for (const poly of geojson.coordinates) {
      const ring = poly?.[0];
      if (Array.isArray(ring) && ring.length > (best?.length || 0)) best = ring;
    }
    return best;
  }

  return null;
}

// Google Encoded Polyline algorithm (minimal implementation)
function encodePolylineLatLng(points) {
  let lastLat = 0;
  let lastLng = 0;
  let result = "";

  const encodeSigned = (num) => {
    let sgnNum = num << 1;
    if (num < 0) sgnNum = ~sgnNum;
    let encoded = "";
    while (sgnNum >= 0x20) {
      encoded += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
      sgnNum >>= 5;
    }
    encoded += String.fromCharCode(sgnNum + 63);
    return encoded;
  };

  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    const dLat = lat - lastLat;
    const dLng = lng - lastLng;
    lastLat = lat;
    lastLng = lng;
    result += encodeSigned(dLat) + encodeSigned(dLng);
  }

  return result;
}

async function fetchStaticMapImage({ lat, lng, parcelPolygon }) {
  const key =
    process.env.GOOGLE_STATIC_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  // Google static maps free/standard sizing constraints; scale=2 for sharper output
  const size = "640x420";

  const params = new URLSearchParams({
    key,
    center: `${lat},${lng}`,
    zoom: String(process.env.PDF_MAP_ZOOM || 18),
    size,
    scale: "2",
    maptype: process.env.PDF_MAP_TYPE || "satellite",
    markers: `color:red|${lat},${lng}`,
  });

  // Optional: draw parcel outline
  const ring = pickParcelRing(parcelPolygon);
  if (ring && ring.length >= 3) {
    const points = ring
      .slice(0, Math.min(ring.length, 300))
      .map(([lng2, lat2]) => ({ lat: Number(lat2), lng: Number(lng2) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    if (points.length >= 3) {
      const enc = encodePolylineLatLng(points);
      const path = `color:0x22c55e|weight:3|enc:${enc}`;
      params.append("path", path);
    }
  }

  const url = `${GOOGLE_STATIC_MAPS_URL}?${params.toString()}`;

  try {
    const resp = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(resp.data);
  } catch (err) {
    console.error(
      "[planner] Could not load static map:",
      (err && err.message) || err
    );
    return null;
  }
}

function ensureSpace(doc, minSpace = 60) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + minSpace > bottom) doc.addPage();
}

function drawSectionHeader(doc, title) {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.fontSize(13).fillColor("#111827").text(title);
  doc
    .moveTo(doc.page.margins.left, doc.y + 4)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 4)
    .lineWidth(1)
    .strokeColor("#e5e7eb")
    .stroke();
  doc.moveDown(0.8);
  doc.fillColor("black");
}

function drawKeyValueTable(doc, rows, opts = {}) {
  const labelWidth = opts.labelWidth || 160;
  const gap = 10;
  const valueWidth =
    doc.page.width -
    doc.page.margins.left -
    doc.page.margins.right -
    labelWidth -
    gap;

  doc.fontSize(10);

  for (const r of rows) {
    ensureSpace(doc, 22);
    const y = doc.y;
    doc
      .fillColor("#374151")
      .text(String(r.label), doc.page.margins.left, y, { width: labelWidth });
    doc
      .fillColor("black")
      .text(
        String(r.value ?? "-"),
        doc.page.margins.left + labelWidth + gap,
        y,
        { width: valueWidth }
      );
    doc.moveDown(0.35);
  }
}

function drawBullets(doc, lines = []) {
  const arr = Array.isArray(lines) ? lines : [];
  doc.fontSize(10).fillColor("black");
  for (const line of arr) {
    const t = safeText(line, "").trim();
    if (!t) continue;
    ensureSpace(doc, 16);
    doc.text(`• ${t}`, { indent: 12 });
  }
}

function drawOverlayTable(doc, overlays = []) {
  const arr = Array.isArray(overlays) ? overlays : [];
  if (!arr.length) {
    doc
      .fontSize(10)
      .text(
        "No overlays were mapped in this pre-assessment (confirm with Council mapping)."
      );
    return;
  }

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;

  const col1 = 190;
  const col2 = 90;
  const col3 = tableWidth - col1 - col2;

  doc.fontSize(10).fillColor("#374151");
  ensureSpace(doc, 24);
  const headerY = doc.y;
  doc.text("Overlay", left, headerY, { width: col1 });
  doc.text("Severity", left + col1, headerY, { width: col2 });
  doc.text("Why it matters / Actions", left + col1 + col2, headerY, {
    width: col3,
  });
  doc.moveDown(0.5);

  doc
    .moveTo(left, doc.y)
    .lineTo(right, doc.y)
    .lineWidth(1)
    .strokeColor("#e5e7eb")
    .stroke();
  doc.moveDown(0.5);

  doc.fillColor("black");

  for (const o of arr) {
    ensureSpace(doc, 44);
    const y = doc.y;

    const name = safeText(o?.name);
    const sev = safeText(o?.severity, "-");

    const why = safeText(o?.whyItMatters, "");
    const actions = Array.isArray(o?.actions)
      ? o.actions.filter(Boolean).slice(0, 4)
      : [];

    const third = [why, ...actions.map((a) => `Action: ${a}`)]
      .filter(Boolean)
      .join("\n");

    doc.text(name, left, y, { width: col1 });
    doc.text(sev, left + col1, y, { width: col2 });
    doc.text(third || "-", left + col1 + col2, y, { width: col3 });

    doc.moveDown(0.8);
  }
}

function drawChecklistTable(doc, checklist = []) {
  const arr = Array.isArray(checklist) ? checklist : [];
  if (!arr.length) {
    doc.fontSize(10).text("No checklist items were produced.");
    return;
  }

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;

  const col1 = 230;
  const col2 = 90;
  const col3 = tableWidth - col1 - col2;

  doc.fontSize(10).fillColor("#374151");
  ensureSpace(doc, 24);
  const headerY = doc.y;
  doc.text("Item", left, headerY, { width: col1 });
  doc.text("Status", left + col1, headerY, { width: col2 });
  doc.text("Notes", left + col1 + col2, headerY, { width: col3 });
  doc.moveDown(0.5);

  doc
    .moveTo(left, doc.y)
    .lineTo(right, doc.y)
    .lineWidth(1)
    .strokeColor("#e5e7eb")
    .stroke();
  doc.moveDown(0.5);

  doc.fillColor("black");

  for (const item of arr) {
    ensureSpace(doc, 36);
    const y = doc.y;

    const topic = safeText(item?.topic);
    const status = safeText(item?.status, "unknown");
    const note = safeText(item?.comment || item?.evidence, "-");

    doc.text(topic, left, y, { width: col1 });
    doc.text(status.toUpperCase(), left + col1, y, { width: col2 });
    doc.text(note, left + col1 + col2, y, { width: col3 });

    doc.moveDown(0.7);
  }
}

function buildPdfBuffer(options) {
  const site = options.site || {};
  const planning = options.planning || {};
  const proposal = options.proposal || {};
  const summary = options.summary || {};
  const classification = options.classification || null;
  const checks = options.checks || null;
  const logoBuffer = options.logoBuffer || null;
  const mapBuffer = options.mapBuffer || null;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (err) => reject(err));

    // Header
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, doc.page.margins.left, 28, { width: 110 });
      } catch (err) {
        console.error(
          "[planner] Failed to render logo into PDF:",
          (err && err.message) || err
        );
      }
    }

    doc
      .fontSize(17)
      .fillColor("#111827")
      .text("Pre-assessment report", 0, 34, { align: "center" });

    doc
      .fontSize(9)
      .fillColor("#6b7280")
      .text(`Generated: ${formatDateTime(new Date())}`, { align: "right" });

    doc.moveDown(2);

    // Executive summary
    const exec = summary.executiveSummary || {};
    const outcome = exec.assessmentOutcome || classification || {};

    drawSectionHeader(doc, "Executive summary");

    doc
      .fontSize(11)
      .fillColor("black")
      .text(safeText(exec.headline, "Pre-assessment summary"));
    doc.moveDown(0.4);

    const outLines = [];
    if (outcome?.devType)
      outLines.push(`Likely development type (guidance): ${outcome.devType}`);
    if (outcome?.assessmentLevel)
      outLines.push(
        `Likely assessment level (guidance): ${outcome.assessmentLevel}`
      );
    if (outcome?.confidence)
      outLines.push(`Confidence: ${String(outcome.confidence).toUpperCase()}`);
    drawBullets(doc, outLines);

    if (Array.isArray(exec.keyFindings) && exec.keyFindings.length) {
      doc.moveDown(0.6);
      doc.fontSize(11).text("Key findings");
      drawBullets(
        doc,
        exec.keyFindings.slice(0, 6).map((f) => {
          const sev = safeText(f?.severity, "info");
          const t = safeText(f?.title, "Finding");
          const d = safeText(f?.detail, "");
          return `[${sev.toUpperCase()}] ${t}${d ? ` – ${d}` : ""}`;
        })
      );
    }

    if (
      Array.isArray(exec.recommendedNextSteps) &&
      exec.recommendedNextSteps.length
    ) {
      doc.moveDown(0.6);
      doc.fontSize(11).text("Recommended next steps");
      drawBullets(doc, exec.recommendedNextSteps.slice(0, 8));
    }

    // Site location (map)
    if (mapBuffer) {
      doc.moveDown(0.8);
      drawSectionHeader(doc, "Site location (indicative)");
      const availableW =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.image(mapBuffer, doc.page.margins.left, doc.y, {
        fit: [availableW, 270],
      });
      doc.moveDown(16);
      doc
        .fontSize(9)
        .fillColor("#6b7280")
        .text(
          "Map is indicative only. Confirm boundaries and overlays using Brisbane City Council mapping and survey information."
        );
      doc.fillColor("black");
    }

    // Key details table
    doc.addPage();
    drawSectionHeader(doc, "Key details");

    const sb = proposal.setbacks || {};
    const dims =
      isNum(proposal.lengthM) && isNum(proposal.widthM)
        ? `${proposal.lengthM} m × ${proposal.widthM} m`
        : "-";
    const heights =
      isNum(proposal.heightRidgeM) || isNum(proposal.heightWallM)
        ? `Ridge: ${isNum(proposal.heightRidgeM) ? proposal.heightRidgeM : "-"} m; Wall: ${
            isNum(proposal.heightWallM) ? proposal.heightWallM : "-"
          } m`
        : "-";

    drawKeyValueTable(doc, [
      { label: "Address", value: safeText(site.address) },
      { label: "Lot / Plan", value: safeText(site.lotPlan) },
      {
        label: "Zoning",
        value:
          safeText(planning.zoning) +
          (planning.zoningCode ? ` (${planning.zoningCode})` : ""),
      },
      {
        label: "Neighbourhood plan",
        value: safeText(planning.neighbourhoodPlan, "-"),
      },
      {
        label: "Neighbourhood precinct",
        value: safeText(planning.neighbourhoodPlanPrecinct, "-"),
      },
      { label: "Proposal purpose", value: safeText(proposal.purpose, "-") },
      { label: "Dimensions", value: dims },
      { label: "Heights", value: heights },
      {
        label: "Setbacks",
        value: `Front: ${isNum(sb.front) ? sb.front : "-"} m; Side 1: ${isNum(sb.side1) ? sb.side1 : "-"} m; Side 2: ${
          isNum(sb.side2) ? sb.side2 : "-"
        } m; Rear: ${isNum(sb.rear) ? sb.rear : "-"} m`,
      },
    ]);

    // Planning controls & overlays
    drawSectionHeader(doc, "Planning controls & overlays");
    const controls = summary.planningControls || {};
    drawKeyValueTable(doc, [
      {
        label: "Zoning",
        value:
          safeText(controls?.zoning?.name || planning.zoning) +
          (controls?.zoning?.code || planning.zoningCode
            ? ` (${controls?.zoning?.code || planning.zoningCode})`
            : ""),
      },
      {
        label: "Neighbourhood plan",
        value:
          safeText(
            controls?.neighbourhoodPlan?.name || planning.neighbourhoodPlan,
            "-"
          ) +
          (controls?.neighbourhoodPlan?.precinct
            ? ` – ${controls.neighbourhoodPlan.precinct}`
            : ""),
      },
    ]);

    drawSectionHeader(doc, "Overlay impacts (preliminary)");
    drawOverlayTable(doc, controls.overlays || planning.overlays || []);

    // Checklist
    doc.addPage();
    drawSectionHeader(
      doc,
      "Assessment checklist (information & likely triggers)"
    );
    if (summary.assessmentChecklist?.length) {
      drawChecklistTable(doc, summary.assessmentChecklist);
    } else if (Array.isArray(checks?.items) && checks.items.length) {
      drawChecklistTable(
        doc,
        checks.items.map((c) => ({
          topic: c.label,
          status: c.status,
          evidence: c.details || "",
          comment: "Confirm against City Plan / certifier advice.",
        }))
      );
    } else {
      doc.fontSize(10).text("Checklist unavailable.");
    }

    // Assumptions / unknowns
    drawSectionHeader(doc, "Assumptions & unknowns");
    drawBullets(doc, summary.assumptionsAndUnknowns || []);

    // Notes from classifier
    if (classification?.reasoning) {
      drawSectionHeader(doc, "Classification reasoning (guidance)");
      doc.fontSize(10).text(String(classification.reasoning));
    }

    // Disclaimer
    drawSectionHeader(doc, "Disclaimer");
    doc
      .fontSize(9)
      .fillColor("#6b7280")
      .text(
        safeText(
          summary.disclaimer,
          "This pre-assessment is guidance only and does not constitute planning approval or legal advice. Confirm requirements with Brisbane City Council and a qualified professional."
        )
      );
    doc.fillColor("black");

    // Page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor("#9ca3af")
        .text(
          `Page ${i + 1} of ${range.count}`,
          doc.page.margins.left,
          doc.page.height - doc.page.margins.bottom + 15,
          {
            width:
              doc.page.width - doc.page.margins.left - doc.page.margins.right,
            align: "right",
          }
        );
    }

    doc.end();
  });
}

export const createPreAssessmentHandler = asyncHandler(async (req, res) => {
  if (!pool) throw new Error("Planner DB is not configured");

  const userId = req.user?.id;
  if (!userId)
    return res.status(401).json({ error: "Authentication required" });

  const body = req.body || {};
  const site = body.site || {};
  const proposal = body.proposal || {};
  const projectId = body.projectId || null;

  if (!site.address) {
    return res
      .status(400)
      .json({ error: "Site.address is required to create a pre-assessment" });
  }

  // 1) Get planning data
  const planning = await fetchPlanningData({
    address: site.address,
    lotPlan: site.lotPlan || null,
  });

  // 2) Classify
  const classification = classifyDevelopment({ site, proposal, planning });

  // 3) Deterministic checks
  const checks = buildPreAssessmentChecks({
    site,
    proposal,
    planning,
    classification,
  });

  // 4) Gemini structured summary (schema v2)
  const summary = await genPreAssessmentSummary({
    site,
    planning,
    proposal,
    classification,
    checks,
  });

  // 5) Load logo (optional)
  let logoBuffer = null;
  try {
    const resp = await axios.get(PDF_LOGO_URL, { responseType: "arraybuffer" });
    logoBuffer = Buffer.from(resp.data);
  } catch (err) {
    console.error(
      "[planner] Could not load PDF logo:",
      (err && err.message) || err
    );
  }

  // 6) Load static map (optional)
  const mapBuffer =
    planning?.geocode?.lat && planning?.geocode?.lng
      ? await fetchStaticMapImage({
          lat: planning.geocode.lat,
          lng: planning.geocode.lng,
          parcelPolygon: planning.siteParcelPolygon,
        })
      : null;

  // 7) Build PDF
  const pdfBuffer = await buildPdfBuffer({
    site,
    planning,
    proposal,
    summary,
    classification,
    checks,
    logoBuffer,
    mapBuffer,
  });

  // 8) Upload PDF
  const key =
    S3_PUBLIC_PREFIX +
    "pre-assessments/" +
    userId +
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

  const preAssessmentMeta = {
    pdfKey: key,
    pdfUrl,
    summary,
    classification,
    checks,
    createdAt: new Date().toISOString(),
  };

  // 9) Upsert project
  let projectRow;

  if (projectId) {
    const existingRes = await pool.query(
      "SELECT * FROM planner_projects WHERE id = $1 AND user_id = $2",
      [projectId, userId]
    );
    if (!existingRes.rows.length)
      return res.status(404).json({ error: "Project not found" });

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
       WHERE id = $9 AND user_id = $10
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
        userId,
      ]
    );

    if (!updated.rows.length)
      return res.status(404).json({ error: "Project not found" });
    projectRow = updated.rows[0];
  } else {
    const title = proposal?.purpose || site.address || "Pre-assessment project";

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

  // 10) Store PDF document metadata
  await pool.query(
    `INSERT INTO planner_documents
       (project_id, type, s3_key, url, mime_type)
     VALUES ($1,$2,$3,$4,$5)`,
    [projectRow.id, "pre_assessment_pdf", key, pdfUrl, "application/pdf"]
  );

  return res.status(201).json({
    project: projectRow,
    preAssessment: {
      id: key,
      projectId: projectRow.id,
      userId,
      pdfKey: key,
      pdfUrl,
      site,
      proposal,
      planningData: planning,
      summary,
      classification,
      checks,
      createdAt: preAssessmentMeta.createdAt,
    },
  });
});
