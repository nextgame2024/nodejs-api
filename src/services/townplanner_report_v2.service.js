// townplanner_report_v2.service.js
import crypto from "crypto";
import axios from "axios";
import { randomUUID } from "crypto";

import { fetchPlanningDataV2 } from "./planningData_v2.service.js";
import { putToS3 } from "./s3.js";
import {
  buildTownPlannerReportPdfV2,
  PDF_ENGINE_VERSION,
} from "./townplanner_report_pdf_v2.service.js";
import { genTownPlannerReportNarrativeV2 } from "./gemini-townplanner_report_v2.service.js";
import pool from "../config/db.js";

const S3_PUBLIC_PREFIX = process.env.S3_PUBLIC_PREFIX || "public/";
const PDF_LOGO_URL =
  process.env.PDF_LOGO_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/sophiaAi-logo.png";

const SCHEME_VERSION = process.env.CITY_PLAN_SCHEME_VERSION || "City Plan 2014";

// Use env override if desired, otherwise use PDF generator’s version stamp
export const REPORT_TEMPLATE_VERSION =
  process.env.TOWNPLANNER_REPORT_TEMPLATE_VERSION ||
  PDF_ENGINE_VERSION ||
  "TPR-PDFKIT-V3";

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

function versionSlug(v) {
  return String(v || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 80);
}

function normalizeDashes(v) {
  return String(v || "")
    .replace(/[–—]/g, "-")
    .trim();
}

function normalizeLookupKey(v) {
  return normalizeDashes(v).toLowerCase().replace(/\s+/g, " ").trim();
}

function extractOverlayBaseName(v) {
  const raw = normalizeDashes(v);
  if (!raw) return "";
  if (raw.includes(" - ")) {
    return raw.split(" - ")[0].trim();
  }
  return raw;
}

function overlayLookupKeysForName(v) {
  const keys = new Set();
  const raw = normalizeDashes(v);
  if (!raw) return [];

  const fullKey = normalizeLookupKey(raw);
  if (fullKey) keys.add(fullKey);

  const baseKey = normalizeLookupKey(extractOverlayBaseName(raw));
  if (baseKey) keys.add(baseKey);

  return Array.from(keys);
}

function parseTableNumber(v) {
  const m = String(v || "").match(
    /([0-9]+(?:\.[0-9]+)+(?:\.[A-Za-z]|[A-Za-z])?)/
  );
  return m?.[1] ? m[1].toUpperCase() : "";
}

function canonicalCitation(v, fallbackNumber = "") {
  const n = parseTableNumber(v) || String(fallbackNumber || "").trim().toUpperCase();
  if (n) return `Table ${n}`;
  const raw = String(v || "").trim();
  return raw || null;
}

function normalizeZoneLookup(zoningName, zoningCode) {
  const rawName = normalizeDashes(zoningName);
  const withoutCodePrefix = rawName.replace(/^[A-Za-z0-9]+\s*-\s*/, "").trim();
  const candidate = withoutCodePrefix || rawName || normalizeDashes(zoningCode);
  return normalizeLookupKey(candidate);
}

function toAssessmentRef(row, fallbackNumber = "") {
  return {
    sourceCitation: canonicalCitation(
      row?.source_citation || row?.label,
      fallbackNumber
    ),
    sourceUrl: row?.source_url || null,
  };
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
  zoningName,
  neighbourhoodPlan,
  precinctCode,
  overlayCodes,
  overlayNames,
}) {
  const scheme = SCHEME_VERSION;
  const zoningAssessmentTableNumbers = ["5.5.1", "5.6.1", "5.7.1", "5.8.1"];

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

  const { rows: contextRows } = await pool.query(sql, params);

  const tableSql = `
    SELECT label, controls, zone_code, neighbourhood_plan, precinct_code, overlay_code, source_url, source_citation
    FROM bcc_planning_controls_v2
    WHERE scheme_version = $1
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(controls->'tables', '[]'::jsonb)) t
        WHERE regexp_replace(
          lower(COALESCE(t->>'table_id', '')),
          '[^0-9.]',
          '',
          'g'
        ) = ANY($2)
      )
  `;

  let tableRows = [];
  try {
    const res = await pool.query(tableSql, [scheme, zoningAssessmentTableNumbers]);
    tableRows = res.rows || [];
  } catch (err) {
    console.warn("[townplanner_v2] failed to load zoning assessment tables", err?.message);
  }

  const dedupe = new Map();
  for (const r of [...contextRows, ...tableRows]) {
    const key = `${r.label || ""}|${r.source_url || ""}|${r.source_citation || ""}`;
    if (!dedupe.has(key)) dedupe.set(key, r);
  }
  const rows = Array.from(dedupe.values());

  const merged = {};
  const tables = [];
  for (const r of contextRows) Object.assign(merged, r.controls || {});
  for (const r of rows) {
    if (Array.isArray(r?.controls?.tables)) {
      tables.push(
        ...r.controls.tables.map((t) => ({
          ...t,
          _sourceLabel: r.label || null,
          _sourceUrl: r.source_url || null,
          _sourceCitation: r.source_citation || null,
        }))
      );
    }
  }

  const zoneLookupKey = normalizeZoneLookup(zoningName, zoningCode);
  const npLookupKey = normalizeLookupKey(neighbourhoodPlan);

  let materialRow = null;
  let reconfigRow = null;
  let buildingRow = null;
  let operationalRow = null;
  let npRow = null;
  let overlayRows = [];

  try {
    const materialPromise = zoneLookupKey
      ? pool.query(
          `
          SELECT label, source_url, source_citation, zone_code, neighbourhood_plan
          FROM bcc_planning_controls_v2
          WHERE scheme_version = $1
            AND (
              source_citation ILIKE 'Table 5.5.%'
              OR label ILIKE 'Table 5.5.%'
            )
            AND (
              lower(replace(replace(COALESCE(neighbourhood_plan, ''), '—', '-'), '–', '-')) = $2
              OR lower(replace(replace(COALESCE(zone_code, ''), '—', '-'), '–', '-')) = $2
              OR lower(replace(replace(COALESCE(label, ''), '—', '-'), '–', '-')) LIKE '%' || $2 || '%'
            )
          ORDER BY
            CASE
              WHEN lower(replace(replace(COALESCE(neighbourhood_plan, ''), '—', '-'), '–', '-')) = $2 THEN 0
              WHEN lower(replace(replace(COALESCE(zone_code, ''), '—', '-'), '–', '-')) = $2 THEN 1
              ELSE 2
            END,
            extracted_at DESC NULLS LAST
          LIMIT 1
          `,
          [scheme, zoneLookupKey]
        )
      : Promise.resolve({ rows: [] });

    const generalPromise = pool.query(
      `
      SELECT label, source_url, source_citation, zone_code, neighbourhood_plan
      FROM bcc_planning_controls_v2
      WHERE scheme_version = $1
        AND lower(replace(replace(COALESCE(zone_code, ''), '—', '-'), '–', '-')) = 'general'
        AND (
          source_citation ILIKE '%5.6.1%'
          OR source_citation ILIKE '%5.7.1%'
          OR source_citation ILIKE '%5.8.1%'
          OR label ILIKE '%5.6.1%'
          OR label ILIKE '%5.7.1%'
          OR label ILIKE '%5.8.1%'
        )
      `,
      [scheme]
    );

    const npPromise = npLookupKey
      ? pool.query(
          `
          SELECT label, source_url, source_citation, zone_code, neighbourhood_plan
          FROM bcc_planning_controls_v2
          WHERE scheme_version = $1
            AND lower(replace(replace(COALESCE(neighbourhood_plan, ''), '—', '-'), '–', '-')) = $2
            AND (
              source_citation ILIKE 'Table 5.9.%'
              OR label ILIKE 'Table 5.9.%'
            )
          ORDER BY extracted_at DESC NULLS LAST
          LIMIT 1
          `,
          [scheme, npLookupKey]
        )
      : Promise.resolve({ rows: [] });

    const overlayLookupKeys = Array.from(
      new Set(
        (Array.isArray(overlayNames) ? overlayNames : [])
          .flatMap((n) => overlayLookupKeysForName(n))
          .filter(Boolean)
      )
    );

    const overlayPromise = overlayLookupKeys.length
      ? pool.query(
          `
          SELECT label, source_url, source_citation, zone_code, neighbourhood_plan, extracted_at
          FROM bcc_planning_controls_v2
          WHERE scheme_version = $1
            AND lower(replace(replace(COALESCE(zone_code, ''), '—', '-'), '–', '-')) = 'overlay'
            AND lower(replace(replace(COALESCE(neighbourhood_plan, ''), '—', '-'), '–', '-')) = ANY($2)
          ORDER BY extracted_at DESC NULLS LAST
          `,
          [scheme, overlayLookupKeys]
        )
      : Promise.resolve({ rows: [] });

    const [materialRes, generalRes, npRes, overlayRes] = await Promise.all([
      materialPromise,
      generalPromise,
      npPromise,
      overlayPromise,
    ]);

    materialRow = materialRes.rows?.[0] || null;
    npRow = npRes.rows?.[0] || null;

    const generalRows = generalRes.rows || [];
    reconfigRow =
      generalRows.find(
        (r) => parseTableNumber(r?.source_citation || r?.label) === "5.6.1"
      ) || null;
    buildingRow =
      generalRows.find(
        (r) => parseTableNumber(r?.source_citation || r?.label) === "5.7.1"
      ) || null;
    operationalRow =
      generalRows.find(
        (r) => parseTableNumber(r?.source_citation || r?.label) === "5.8.1"
      ) || null;
    overlayRows = overlayRes.rows || [];
  } catch (err) {
    console.warn(
      "[townplanner_v2] failed to load assessment reference rows",
      err?.message
    );
  }

  const overlayAssessmentRefs = {};
  for (const r of overlayRows) {
    const k = normalizeLookupKey(r?.neighbourhood_plan);
    if (!k || overlayAssessmentRefs[k]) continue;
    overlayAssessmentRefs[k] = toAssessmentRef(r);
  }

  return {
    schemeVersion: scheme,
    mergedControls: merged,
    sources: contextRows.map((r) => ({
      label: r.label,
      zoneCode: r.zone_code,
      neighbourhoodPlan: r.neighbourhood_plan,
      precinctCode: r.precinct_code,
      overlayCode: r.overlay_code,
      sourceUrl: r.source_url,
      sourceCitation: r.source_citation,
    })),
    assessmentRefs: {
      neighbourhoodPlan: toAssessmentRef(npRow),
      material: toAssessmentRef(materialRow, "5.5.1"),
      reconfiguring: toAssessmentRef(reconfigRow, "5.6.1"),
      building: toAssessmentRef(buildingRow, "5.7.1"),
      operational: toAssessmentRef(operationalRow, "5.8.1"),
      overlays: overlayAssessmentRefs,
    },
    tables,
  };
}

export async function generateTownPlannerReportV2({
  token,
  addressLabel,
  placeId = null,
  lat,
  lng,
  lotPlan = null,
}) {
  const planning = await fetchPlanningDataV2({ lat, lng, lotPlan });

  // Keep your existing “must have parcel boundary” guard
  if (!planning || !planning.siteParcelPolygon) {
    const details = {
      hasPlanning: !!planning,
      hasParcel: !!planning?.siteParcelPolygon,
      hasZoning: !!planning?.zoningPolygon,
      zoning: planning?.zoning,
      lat,
      lng,
      placeId,
      addressLabel,
    };
    console.error(
      "[townplanner_v2] planning snapshot incomplete; refusing PDF",
      details
    );
    throw new Error(
      "Planning layers not available for this location (parcel boundary missing). " +
        "Please try again or verify the cadastral dataset is loaded."
    );
  }

  const overlayCodes = (planning?.overlays || []).map((o) => o.code);
  const overlayNames = (planning?.overlays || []).map((o) => o.name);
  const controls = await getControlsV2({
    zoningCode: planning?.zoningCode,
    zoningName: planning?.zoning,
    neighbourhoodPlan: planning?.neighbourhoodPlan,
    precinctCode: planning?.neighbourhoodPlanPrecinctCode,
    overlayCodes,
    overlayNames,
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
  const generatedAt = new Date().toISOString();

  console.info("[townplanner_v2] generating PDF with engine:", {
    token,
    REPORT_TEMPLATE_VERSION,
  });

  const pdfBuffer = await buildTownPlannerReportPdfV2({
    schemeVersion: controls.schemeVersion,
    addressLabel,
    placeId,
    lat,
    lng,
    lotPlan,
    planning,
    controls,
    narrative,
    logoBuffer,
    generatedAt,
  });

  const address = addressSlug(addressLabel);
  const ts = Date.now();
  const vslug = versionSlug(REPORT_TEMPLATE_VERSION);

  // IMPORTANT: versioned key path so old PDFs are obviously old
  const key =
    S3_PUBLIC_PREFIX +
    `townplanner-v2/reports/${vslug}/${address}/${ts}-${randomUUID()}.pdf`;

  const pdfUrl = await putToS3({
    key,
    body: pdfBuffer,
    contentType: "application/pdf",
  });

  return {
    pdfKey: key,
    pdfUrl,
    reportJson: {
      templateVersion: REPORT_TEMPLATE_VERSION,
      schemeVersion: controls.schemeVersion,
      addressLabel,
      placeId,
      lat,
      lng,
      lotPlan,
      planning,
      controls,
      narrative,
      generatedAt,
    },
    planningSnapshot: planning,
  };
}

export function computeInputsHashV2(payload) {
  return sha256(payload);
}
