import crypto from "crypto";
import axios from "axios";
import { randomUUID } from "crypto";

import { fetchPlanningDataV2 } from "./planningData_v2.service.js";
import { putToS3 } from "./s3.js";
import { buildTownPlannerReportPdfV2 } from "./townplanner_report_pdf_v2.service.js";
import { genTownPlannerReportNarrativeV2 } from "./gemini-townplanner_report_v2.service.js";
import pool from "../config/db.js";

const S3_PUBLIC_PREFIX = process.env.S3_PUBLIC_PREFIX || "public/";
const PDF_LOGO_URL =
  process.env.PDF_LOGO_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/sophiaAi-logo.png";

const SCHEME_VERSION = process.env.CITY_PLAN_SCHEME_VERSION || "City Plan 2014";

function sha256(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function addressSlug(addressLabel) {
  return (
    String(addressLabel || "unknown-address")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unknown-address"
  );
}

async function loadLogoBuffer() {
  try {
    const resp = await axios.get(PDF_LOGO_URL, { responseType: "arraybuffer" });
    return Buffer.from(resp.data);
  } catch {
    return null;
  }
}

async function getControlsV2({
  zoningCode,
  neighbourhoodPlan,
  precinctCode,
  overlayCodes,
}) {
  const scheme = SCHEME_VERSION;

  const sql = `
    SELECT label, controls, zone_code, neighbourhood_plan, precinct_code, overlay_code, source_url, source_citation
    FROM bcc_planning_controls_v2
    WHERE scheme_version = $1
      AND (
        (zone_code IS NOT NULL AND zone_code = $2)
        OR (neighbourhood_plan IS NOT NULL AND neighbourhood_plan = $3)
        OR (precinct_code IS NOT NULL AND precinct_code = $4)
        OR (overlay_code IS NOT NULL AND overlay_code = ANY($5))
      )
  `;

  const params = [
    scheme,
    zoningCode || null,
    neighbourhoodPlan || null,
    precinctCode || null,
    Array.isArray(overlayCodes) ? overlayCodes : [],
  ];

  const { rows } = await pool.query(sql, params);

  const merged = {};
  for (const r of rows) Object.assign(merged, r.controls || {});

  return {
    schemeVersion: scheme,
    mergedControls: merged,
    sources: rows.map((r) => ({
      label: r.label,
      zoneCode: r.zone_code,
      neighbourhoodPlan: r.neighbourhood_plan,
      precinctCode: r.precinct_code,
      overlayCode: r.overlay_code,
      sourceUrl: r.source_url,
      sourceCitation: r.source_citation,
    })),
  };
}

export async function generateTownPlannerReportV2({
  token,
  addressLabel,
  placeId = null,
  lat,
  lng,
}) {
  const planning = await fetchPlanningDataV2({ lat, lng });

  const overlayCodes = (planning?.overlays || []).map((o) => o.code);
  const controls = await getControlsV2({
    zoningCode: planning?.zoningCode,
    neighbourhoodPlan: planning?.neighbourhoodPlan,
    precinctCode: planning?.neighbourhoodPlanPrecinctCode,
    overlayCodes,
  });

  const narrative = await genTownPlannerReportNarrativeV2({
    schemeVersion: controls.schemeVersion,
    addressLabel,
    placeId,
    lat,
    lng,
    planning,
    controls,
  });

  const logoBuffer = await loadLogoBuffer();

  const pdfBuffer = await buildTownPlannerReportPdfV2({
    schemeVersion: controls.schemeVersion,
    addressLabel,
    placeId,
    lat,
    lng,
    planning,
    controls,
    narrative,
    logoBuffer,
  });

  const address = addressSlug(addressLabel);
  const ts = Date.now();

  const key =
    S3_PUBLIC_PREFIX +
    `townplanner-v2/reports/${address}/${ts}-${randomUUID()}.pdf`;

  const pdfUrl = await putToS3({
    key,
    body: pdfBuffer,
    contentType: "application/pdf",
  });

  return {
    pdfKey: key,
    pdfUrl,
    reportJson: {
      schemeVersion: controls.schemeVersion,
      addressLabel,
      placeId,
      lat,
      lng,
      planning,
      controls,
      narrative,
      generatedAt: new Date().toISOString(),
    },
    planningSnapshot: planning,
  };
}

export function computeInputsHashV2(payload) {
  return sha256(payload);
}
