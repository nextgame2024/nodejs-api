// townplanner_report_pdf_v2.service.js
import PDFDocument from "pdfkit";
import * as turf from "@turf/turf";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
} from "./googleStaticMaps_v2.service.js";

export const PDF_ENGINE_VERSION = "TPR-PDFKIT-V3-2026-02-20.29";

function safeJsonParse(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
function pickFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return null;
}
function pickProp(props, keys = []) {
  if (!props || typeof props !== "object") return null;
  for (const key of keys) {
    if (props[key] !== undefined && props[key] !== null && props[key] !== "") {
      return props[key];
    }
    const target = String(key || "").toLowerCase();
    if (!target) continue;
    const hit = Object.keys(props).find(
      (k) => String(k || "").toLowerCase() === target,
    );
    if (
      hit &&
      props[hit] !== undefined &&
      props[hit] !== null &&
      props[hit] !== ""
    ) {
      return props[hit];
    }
  }
  return null;
}
function featureFromGeometry(geometry, props = {}) {
  if (!geometry) return null;
  return { type: "Feature", properties: props, geometry };
}
function formatAreaM2(area) {
  const n = Number(area);
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  return `${Math.round(n).toLocaleString("en-AU")} m²`;
}
function formatDateAU(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}
function formatCoords(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "N/A";
  return `${a.toFixed(6)}, ${b.toFixed(6)}`;
}

function formatLotPlanLine(lotPlanRaw, lotNumber, planNumber) {
  const raw = String(lotPlanRaw || "").trim();
  let lot = String(lotNumber || "").trim();
  let plan = String(planNumber || "").trim();

  const parseConcat = (v) => {
    const m = String(v || "")
      .trim()
      .match(/^([A-Za-z0-9]+?)(RP|SP|BUP|PS|L|CP|OP|DP)(\d+)$/i);
    if (!m) return null;
    return { lot: m[1], plan: `${m[2]}${m[3]}` };
  };

  if (raw) {
    if (/^lot\s+/i.test(raw)) return raw;
    if (/^plan\s+/i.test(raw)) return raw;

    const concat = parseConcat(raw);
    if (concat) {
      if (!lot) lot = concat.lot;
      if (!plan) plan = concat.plan;
      return lot ? `Lot ${lot} on ${plan}` : `Plan ${plan}`;
    }

    if (/^(rp|sp|bup|ps|l|cp|op|dp)\d+/i.test(raw)) {
      return lot ? `Lot ${lot} on ${raw}` : `Plan ${raw}`;
    }
    if (/\bon\b/i.test(raw) && !/^lot\b/i.test(raw)) return `Lot ${raw}`;

    const m = raw.match(/^([A-Za-z0-9]+)\s*[/\s]\s*([A-Za-z0-9]+)$/);
    if (m) return `Lot ${m[1]} on ${m[2]}`;

    if (lot && plan) return `Lot ${lot} on ${plan}`;
    return `Lot ${raw}`;
  }

  if (lot && plan) return `Lot ${lot} on ${plan}`;
  if (lot) return `Lot ${lot}`;
  if (plan) return `Plan ${plan}`;
  return "";
}

const BRAND = {
  teal: "#0F2B2B",
  teal2: "#143838",
  link: "#1E63C6",
  green: "#2ecc71",
  text: "#111111",
  muted: "#5A5F66",
  light: "#F5F7F8",
  border: "#E2E6E9",
  white: "#FFFFFF",
};

const PAGE = {
  size: "A4",
  margin: 56,
};

const TABLE = {
  headerFill: "#F1F3F5",
  sectionFill: "#F7F9FA",
  border: "#D8DDE1",
  text: "#111111",
  pad: 6,
};

function contentW(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}
function X(doc) {
  return doc.page.margins.left;
}
function Y(doc) {
  return doc.page.margins.top;
}

function rr(doc, x, y, w, h, r = 14) {
  doc.roundedRect(x, y, w, h, r);
}

function box(
  doc,
  x,
  y,
  w,
  h,
  { fill = BRAND.light, stroke = BRAND.border, r = 14 } = {},
) {
  doc.save();
  rr(doc, x, y, w, h, r);
  doc.fillColor(fill).fill();
  doc.restore();

  doc.save();
  rr(doc, x, y, w, h, r);
  doc.strokeColor(stroke).lineWidth(1).stroke();
  doc.restore();
}

function tableRowHeight(doc, cells, widths, font, fontSize, pad) {
  let max = 0;
  doc.font(font).fontSize(fontSize);
  for (let i = 0; i < widths.length; i += 1) {
    const text = String(cells[i] || "");
    const h = doc.heightOfString(text, {
      width: Math.max(10, widths[i] - pad * 2),
      align: "left",
    });
    if (h > max) max = h;
  }
  return Math.max(18, max + pad * 2);
}

function drawTableRow(doc, x, y, widths, cells, opts = {}) {
  const {
    fill = null,
    stroke = TABLE.border,
    font = "Helvetica",
    fontSize = 9,
    color = TABLE.text,
    pad = TABLE.pad,
  } = opts;

  const h = tableRowHeight(doc, cells, widths, font, fontSize, pad);
  const totalW = widths.reduce((sum, v) => sum + v, 0);

  if (fill) {
    doc.save();
    doc.rect(x, y, totalW, h).fill(fill);
    doc.restore();
  }

  let cx = x;
  for (let i = 0; i < widths.length; i += 1) {
    doc.save();
    doc.rect(cx, y, widths[i], h).strokeColor(stroke).lineWidth(1).stroke();
    doc.restore();

    doc
      .fillColor(color)
      .font(font)
      .fontSize(fontSize)
      .text(String(cells[i] || ""), cx + pad, y + pad, {
        width: Math.max(10, widths[i] - pad * 2),
        align: "left",
      });
    cx += widths[i];
  }

  return h;
}

function drawSectionRow(doc, x, y, w, title, opts = {}) {
  const {
    fill = TABLE.sectionFill,
    stroke = TABLE.border,
    font = "Helvetica-Bold",
    fontSize = 9,
    color = TABLE.text,
    pad = TABLE.pad,
  } = opts;
  const h =
    doc
      .font(font)
      .fontSize(fontSize)
      .heightOfString(String(title || ""), {
        width: Math.max(10, w - pad * 2),
        align: "left",
      }) +
    pad * 2;
  doc.save();
  doc.rect(x, y, w, h).fill(fill);
  doc.restore();
  doc.save();
  doc.rect(x, y, w, h).strokeColor(stroke).lineWidth(1).stroke();
  doc.restore();
  doc
    .fillColor(color)
    .font(font)
    .fontSize(fontSize)
    .text(String(title || ""), x + pad, y + pad, {
      width: Math.max(10, w - pad * 2),
      align: "left",
    });
  return h;
}

/**
 * PDFKit does NOT clip text to a "height" option. If text exceeds page height,
 * PDFKit will auto-add pages. This helper prevents auto-flow by limiting lines.
 */
function boundedText(
  doc,
  text,
  x,
  y,
  w,
  h,
  {
    font = "Helvetica",
    fontSize = 9,
    color = BRAND.muted,
    lineGap = 2,
    ellipsis = true,
    align = "left",
  } = {},
) {
  const full = String(text ?? "");

  doc.font(font).fontSize(fontSize).fillColor(color);

  const measureOpts = { width: w, align, lineGap };

  // If it fits, render as-is
  try {
    const fullHeight = doc.heightOfString(full, measureOpts);
    if (fullHeight <= h) {
      doc.text(full, x, y, measureOpts);
      return;
    }
  } catch {
    // continue to fallback fitting
  }

  // Binary search to find the largest substring that fits into height
  const suffix = ellipsis ? "…" : "";
  let lo = 0;
  let hi = full.length;
  let best = "";

  const fits = (s) => {
    try {
      return doc.heightOfString(s, measureOpts) <= h;
    } catch {
      return false;
    }
  };

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let candidate = full.slice(0, mid);

    // Avoid cutting mid-word: trim to last whitespace if possible
    if (candidate.length < full.length) {
      const trimmed = candidate.replace(/\s+\S*$/, "");
      if (trimmed.length > 0) candidate = trimmed;
    }

    const withSuffix = candidate + suffix;

    if (fits(withSuffix)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const out = (best || full.slice(0, 1)) + suffix;
  doc.text(out, x, y, measureOpts);
}

function splitOverlayName(name) {
  const raw = String(name || "").trim();
  if (!raw) return { base: "", detail: "" };
  if (raw.includes(" – ")) {
    const [base, ...rest] = raw.split(" – ");
    return { base: base.trim(), detail: rest.join(" – ").trim() };
  }
  if (raw.includes(" - ")) {
    const [base, ...rest] = raw.split(" - ");
    return { base: base.trim(), detail: rest.join(" - ").trim() };
  }
  return { base: raw, detail: "" };
}

function normalizeOverlayKey(v) {
  return String(v || "")
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeOverlaySubcategory(v) {
  return String(v || "")
    .replace(/security\s*label\s*:?.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function overlayLookupKeysForName(name) {
  const keys = new Set();
  const raw = String(name || "")
    .replace(/[–—]/g, "-")
    .trim();

  const pushWithAliases = (candidate) => {
    const k = normalizeOverlayKey(candidate);
    if (!k) return;
    keys.add(k);
    if (k.includes("critical infrastructure and movement areas overlay")) {
      keys.add(
        k.replace(
          "critical infrastructure and movement areas overlay",
          "critical infrastructure and movement network overlay",
        ),
      );
    }
    if (k.includes("critical infrastructure and movement network overlay")) {
      keys.add(
        k.replace(
          "critical infrastructure and movement network overlay",
          "critical infrastructure and movement areas overlay",
        ),
      );
    }
  };

  if (raw) pushWithAliases(raw);
  const { base } = splitOverlayName(raw);
  if (base && base !== raw) pushWithAliases(base);
  return Array.from(keys);
}

function buildCriticalOverlayHatchGeoJson(parcelGeometry, centerPoint) {
  let minLng = null;
  let minLat = null;
  let maxLng = null;
  let maxLat = null;

  try {
    const parcelFeature = featureFromGeometry(parcelGeometry);
    const b = parcelFeature ? turf.bbox(parcelFeature) : null;
    if (Array.isArray(b) && b.length === 4) {
      [minLng, minLat, maxLng, maxLat] = b;
      const width = Math.max(0.0001, maxLng - minLng);
      const height = Math.max(0.0001, maxLat - minLat);
      // Localized hatch window around the site parcel.
      const padLng = Math.max(width * 4, 0.0032);
      const padLat = Math.max(height * 4, 0.0024);
      minLng -= padLng;
      maxLng += padLng;
      minLat -= padLat;
      maxLat += padLat;
    }
  } catch {}

  if (
    !Number.isFinite(minLng) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLng) ||
    !Number.isFinite(maxLat)
  ) {
    const lat = Number(centerPoint?.lat);
    const lng = Number(centerPoint?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    minLng = lng - 0.0055;
    maxLng = lng + 0.0055;
    minLat = lat - 0.0042;
    maxLat = lat + 0.0042;
  }

  const width = maxLng - minLng;
  const height = maxLat - minLat;
  if (!(width > 0 && height > 0)) return null;

  const span = width + height;
  // Extra-dense hatch pattern to match City Plan visual style.
  const step = Math.max(Math.min(span / 420, 0.00008), 0.00003);
  const start = minLng - height;
  const end = maxLng + height;

  const lines = [];
  for (let x = start; x <= end; x += step) {
    lines.push([
      [x, minLat],
      [x + width + height, maxLat],
    ]);
    if (lines.length >= 900) break;
  }

  return featureFromGeometry({
    type: "MultiLineString",
    coordinates: lines,
  });
}

function lineCandidatesFromGeometry(geometry) {
  if (!geometry) return [];
  const type = String(geometry?.type || "");

  if (type === "LineString" || type === "MultiLineString") {
    const f = featureFromGeometry(geometry);
    return f ? [f] : [];
  }

  if (type === "Polygon" || type === "MultiPolygon") {
    try {
      const polyFeature = featureFromGeometry(geometry);
      if (!polyFeature) return [];
      const line = turf.polygonToLine(polyFeature);
      if (!line) return [];
      if (line.type === "FeatureCollection") {
        return (line.features || []).filter(
          (f) =>
            f?.geometry?.type === "LineString" ||
            f?.geometry?.type === "MultiLineString",
        );
      }
      if (
        line.type === "Feature" &&
        (line?.geometry?.type === "LineString" ||
          line?.geometry?.type === "MultiLineString")
      ) {
        return [line];
      }
    } catch {}
    return [];
  }

  if (type === "GeometryCollection") {
    const out = [];
    for (const g of geometry?.geometries || []) {
      out.push(...lineCandidatesFromGeometry(g));
    }
    return out;
  }

  return [];
}

function nearestOverlayBoundaryPoint(baseCenter, geometry) {
  if (!baseCenter || !geometry) return null;
  const lat = Number(baseCenter.lat);
  const lng = Number(baseCenter.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const origin = turf.point([lng, lat]);
  const lines = lineCandidatesFromGeometry(geometry);
  if (!lines.length) return null;

  let best = null;
  for (const line of lines) {
    try {
      const near = turf.nearestPointOnLine(line, origin, {
        units: "kilometers",
      });
      const coords = near?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const rawDist = Number(near?.properties?.dist);
      const distKm = Number.isFinite(rawDist)
        ? rawDist
        : turf.distance(origin, near, { units: "kilometers" });
      if (!best || distKm < best.distKm) {
        best = { lng: Number(coords[0]), lat: Number(coords[1]), distKm };
      }
    } catch {}
  }

  return best;
}

function deriveAirportMapCenter(baseCenter, pansGeometry, blueGeometry) {
  if (!baseCenter) return null;
  const lat = Number(baseCenter.lat);
  const lng = Number(baseCenter.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const pansNear = nearestOverlayBoundaryPoint(baseCenter, pansGeometry);
  const blueNear = nearestOverlayBoundaryPoint(baseCenter, blueGeometry);

  let targetLng = lng;
  if (pansNear && blueNear) {
    const lowLng = Math.min(pansNear.lng, blueNear.lng);
    const highLng = Math.max(pansNear.lng, blueNear.lng);
    const gapLng = Math.max(0, highLng - lowLng);
    const midpointLng = (lowLng + highLng) / 2;
    // Keep both boundaries inside frame, with a slight west bias so parcel stays visible.
    targetLng = midpointLng - gapLng * 0.1;
  } else if (blueNear) {
    targetLng = lng * 0.6 + blueNear.lng * 0.4;
  } else if (pansNear) {
    targetLng = lng * 0.75 + pansNear.lng * 0.25;
  } else {
    targetLng = lng + 0.0066;
  }

  const deltaLng = Math.max(-0.012, Math.min(0.012, targetLng - lng));
  return { lat, lng: lng + deltaLng };
}

function geometryDebugStats(geometry) {
  if (!geometry) return { present: false };

  const stats = {
    present: true,
    type: String(geometry?.type || "Unknown"),
    polygonCount: 0,
    lineCount: 0,
    pointCount: 0,
  };

  const walk = (g) => {
    if (!g) return;
    const t = String(g?.type || "");
    if (t === "Polygon" || t === "MultiPolygon") stats.polygonCount += 1;
    else if (t === "LineString" || t === "MultiLineString")
      stats.lineCount += 1;
    else if (t === "Point" || t === "MultiPoint") stats.pointCount += 1;
    else if (t === "GeometryCollection") {
      for (const child of g?.geometries || []) walk(child);
    }
  };
  walk(geometry);

  try {
    const feature = featureFromGeometry(geometry);
    if (feature) {
      const bbox = turf.bbox(feature);
      if (Array.isArray(bbox) && bbox.length === 4) {
        stats.bbox = bbox.map((v) => Number(Number(v).toFixed(6)));
      }
    }
  } catch {}

  return stats;
}

function buildOverlayLines(items, limit = 14) {
  if (!Array.isArray(items) || items.length === 0) {
    return ["• No overlays returned for this site."];
  }

  const lines = [];
  for (const item of items) {
    const { base, detail } = splitOverlayName(item?.name);
    if (!base) continue;
    lines.push(`• ${base}`);
    if (detail) lines.push(`  - ${detail}`);
    if (lines.length >= limit) break;
  }

  return lines.length ? lines : ["• No overlays returned for this site."];
}

function addExternalLink(doc, x, y, w, h, url) {
  if (!url) return;
  // Ask viewers to open externally in a new window/tab; keep URI fallback.
  const safeUrl = String(url).trim();
  if (!safeUrl) return;
  const escapedForJs = safeUrl
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

  const uriAction = doc.ref({
    S: "URI",
    URI: new String(safeUrl),
    NewWindow: true,
  });
  uriAction.end();

  const jsAction = doc.ref({
    S: "JavaScript",
    JS: new String(`app.launchURL('${escapedForJs}', true);`),
    Next: uriAction,
  });
  jsAction.end();

  doc.annotate(x, y, w, h, {
    Subtype: "Link",
    A: jsAction,
    Border: [0, 0, 0],
    F: 1 << 2,
  });
}

function header(doc, { title, addressLabel, schemeVersion, logoBuffer }) {
  const x = X(doc);
  const y = Y(doc);
  const w = contentW(doc);

  doc.save();
  rr(doc, x, y - 6, w, 44, 14);
  doc.fillColor(BRAND.teal).fill();
  doc.restore();

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x + 14, y + 6, { height: 18 });
    } catch {
      doc
        .fillColor(BRAND.white)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("sophiaAi", x + 14, y + 9);
    }
  } else {
    doc
      .fillColor(BRAND.white)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("sophiaAi", x + 14, y + 9);
  }

  doc
    .fillColor(BRAND.white)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(title || "", x, y + 9, { width: w, align: "center" });

  doc
    .fillColor(BRAND.white)
    .font("Helvetica")
    .fontSize(8)
    .text(schemeVersion || "", x, y + 12, { width: w - 14, align: "right" });

  // Address line under header band (bounded)
  boundedText(doc, addressLabel || "", x, y + 46, w, 16, {
    font: "Helvetica",
    fontSize: 9,
    color: BRAND.muted,
    ellipsis: true,
  });

  // thin rule
  doc.save();
  doc
    .strokeColor(BRAND.border)
    .lineWidth(1)
    .moveTo(x, y + 66)
    .lineTo(x + w, y + 66)
    .stroke();
  doc.restore();
}

function footerAllPages(doc, schemeVersion) {
  const range = doc.bufferedPageRange();
  const total = range.count;

  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);

    const x = X(doc);
    const w = contentW(doc);
    // IMPORTANT: PDFKit will auto-add a new page if you draw text below maxY
    // (page height minus bottom margin). Keeping the footer within the text
    // boundary prevents PDFKit from creating trailing blank pages.
    const y = doc.page.height - doc.page.margins.bottom - 18;

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text("Brisbane Town Planner • sophiaAi", x, y, {
        width: w,
        align: "left",
      });

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(schemeVersion || "", x, y, { width: w, align: "center" });

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(`Page ${i + 1} of ${total}`, x, y, { width: w, align: "right" });
  }
}

function computeIntersectionAreaM2(parcelGeom, overlayGeom) {
  try {
    if (!parcelGeom || !overlayGeom) return null;
    const parcel = featureFromGeometry(parcelGeom);
    const overlay = featureFromGeometry(overlayGeom);
    if (!parcel || !overlay) return null;
    const inter = turf.intersect(parcel, overlay);
    if (!inter) return 0;
    const a = turf.area(inter);
    return Number.isFinite(a) ? a : null;
  } catch {
    return null;
  }
}

/** Draw an image cropped-to-fill (cover) inside a rounded container. */
function drawCoverImageInRoundedBox(doc, img, x, y, w, h, r = 14) {
  box(doc, x, y, w, h, { fill: BRAND.light, stroke: BRAND.border, r });
  if (!img) return;

  // Clip to rounded rect and cover-fill (crop) to remove right-side whitespace
  doc.save();
  rr(doc, x, y, w, h, r);
  doc.clip();
  try {
    doc.image(img, x, y, { cover: [w, h] });
  } catch {
    // fallback: fit
    try {
      doc.image(img, x, y, { fit: [w, h] });
    } catch {}
  }
  doc.restore();
}

export async function buildTownPlannerReportPdfV2(
  reportPayload = {},
  opts = {},
) {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY_SERVER ||
    null;

  const schemeVersion =
    pickFirst(
      reportPayload.schemeVersion,
      reportPayload?.controls?.schemeVersion,
    ) ||
    process.env.CITY_PLAN_SCHEME_VERSION ||
    "City Plan 2014";

  const addressLabel =
    pickFirst(
      reportPayload.addressLabel,
      reportPayload.address_label,
      reportPayload?.inputs?.addressLabel,
      reportPayload?.inputs?.address_label,
    ) || "Address not provided";

  const lat =
    pickFirst(reportPayload.lat, reportPayload?.inputs?.lat, opts.lat) ?? null;
  const lng =
    pickFirst(reportPayload.lng, reportPayload?.inputs?.lng, opts.lng) ?? null;

  const generatedAt =
    pickFirst(
      reportPayload.generatedAt,
      reportPayload?.reportJson?.generatedAt,
    ) || new Date().toISOString();

  const logoBuffer = reportPayload.logoBuffer || null;

  const planningSnapshot =
    safeJsonParse(
      pickFirst(
        reportPayload.planningSnapshot,
        reportPayload.planning_snapshot,
        reportPayload.planning,
        reportPayload?.inputs?.planningSnapshot,
        reportPayload?.inputs?.planning_snapshot,
      ),
    ) || {};

  const parcelProps = planningSnapshot?.propertyParcel?.properties || null;

  const lotPlanRaw = pickFirst(
    reportPayload.lotPlan,
    reportPayload.lot_plan,
    reportPayload?.inputs?.lotPlan,
    reportPayload?.inputs?.lot_plan,
    planningSnapshot?.lotPlan,
    planningSnapshot?.lot_plan,
    pickProp(parcelProps, [
      "lot_plan",
      "lotplan",
      "lot_plan_desc",
      "lotplan_desc",
      "lot_plan_number",
      "lotplan_number",
      "lot_plan_no",
      "lotplan_no",
      "lotplanid",
      "lot_plan_id",
    ]),
  );

  const lotNumber = pickProp(parcelProps, [
    "lot",
    "lot_number",
    "lot_no",
    "lotnum",
    "lotno",
    "lot_id",
  ]);

  const planNumber = pickProp(parcelProps, [
    "plan",
    "plan_number",
    "plan_no",
    "planno",
    "plan_id",
  ]);

  const lotPlanLine = formatLotPlanLine(lotPlanRaw, lotNumber, planNumber);

  const controls =
    safeJsonParse(
      pickFirst(reportPayload.controls, reportPayload?.inputs?.controls),
    ) || {};

  const narrative =
    safeJsonParse(
      pickFirst(reportPayload.narrative, reportPayload?.inputs?.narrative),
    ) || null;

  const mergedControls = controls?.mergedControls || {};
  const sources = Array.isArray(controls?.sources) ? controls.sources : [];
  const assessmentRefs = controls?.assessmentRefs || {};

  const parseTableNumber = (value) => {
    const m = String(value || "").match(
      /([0-9]+(?:\.[0-9]+)+(?:\.[A-Za-z]|[A-Za-z])?)/,
    );
    return m?.[1] ? m[1].toUpperCase() : "";
  };

  const canonicalCitation = (value, fallbackNumber = "") => {
    const number =
      parseTableNumber(value) ||
      String(fallbackNumber || "")
        .trim()
        .toUpperCase();
    if (number) return `Table ${number}`;
    const raw = String(value || "").trim();
    return raw || null;
  };

  const buildAssessmentRef = (rawRef, fallbackNumber) => {
    const citation = canonicalCitation(rawRef?.sourceCitation, fallbackNumber);
    const number = parseTableNumber(citation) || fallbackNumber;
    return {
      label: `Table of assessment ${number}`,
      url: rawRef?.sourceUrl || null,
    };
  };

  const parcelGeom =
    pickFirst(
      planningSnapshot.siteParcelPolygon,
      planningSnapshot?.propertyParcel?.geometry,
    ) || null;

  const zoningGeom =
    pickFirst(
      planningSnapshot.zoningPolygon,
      planningSnapshot?.zoning?.geometry,
    ) || null;

  const parcelFeature = featureFromGeometry(parcelGeom);
  const zoningFeature = featureFromGeometry(zoningGeom);

  const areaM2 =
    planningSnapshot?.propertyParcel?.debug?.areaM2 ??
    planningSnapshot?.propertyParcel?.debug?.area_m2 ??
    null;

  const center =
    lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;

  const overlays = Array.isArray(planningSnapshot?.overlays)
    ? planningSnapshot.overlays
    : [];
  const overlayPolygons = Array.isArray(planningSnapshot?.overlayPolygons)
    ? planningSnapshot.overlayPolygons
    : [];

  const findOverlayGeometry = (code) => {
    const hit = overlayPolygons.find((o) => o?.code === code && o?.geometry);
    return hit?.geometry || null;
  };

  // Pre-render maps (best-effort)
  const siteContextMap = parcelFeature
    ? await getParcelMapImageBufferV2({
        apiKey,
        center,
        parcelGeoJson: parcelFeature,
        zoom: 18,
        maptype: "hybrid",
        size: "640x420",
        scale: 2,
      }).catch(() => null)
    : null;

  const parcelRoadMap = parcelFeature
    ? await getParcelMapImageBufferV2({
        apiKey,
        center,
        parcelGeoJson: parcelFeature,
        zoom: 19,
        maptype: "roadmap",
        size: "640x420",
        scale: 2,
      }).catch(() => null)
    : null;

  if (parcelFeature && zoningFeature) {
    console.info("[townplanner_v2][zoning_map_debug] inputs", {
      center,
      zoningName: planningSnapshot?.zoning || null,
      zoningCode: planningSnapshot?.zoningCode || null,
      parcelGeom: geometryDebugStats(parcelGeom),
      zoningGeom: geometryDebugStats(zoningGeom),
    });
  }

  let zoningMap = null;
  if (parcelFeature && zoningFeature) {
    zoningMap = await getParcelOverlayMapImageBufferV2({
      apiKey,
      center,
      parcelGeoJson: parcelFeature,
      overlayGeoJson: zoningFeature,
      overlayLayers: [
        {
          geoJson: zoningFeature,
          color: "0x00000000",
          fill: "0xff8a8a4d",
          weight: 1,
          includeHoles: false,
          maxRings: 24,
        },
      ],
      debugLabel: "zoning-map",
      parcelColor: "0xffeb3bff",
      parcelFill: "0xffeb3b22",
      overlayColor: "0x00000000",
      overlayFill: "0xff8a8a4d",
      overlayWeight: 1,
      zoom: 22,
      paddingPx: 96,
      maptype: "hybrid",
      size: "640x380",
      scale: 2,
    }).catch(() => null);

    console.info("[townplanner_v2][zoning_map_debug] map result", {
      hasBuffer: !!zoningMap,
      mapBufferBytes: zoningMap?.length || 0,
    });
  }

  const overlayColorPalette = [
    { outline: "0xff7f00ff", fill: "0xff7f002e" },
    { outline: "0x7b61ffff", fill: "0x7b61ff2e" },
    { outline: "0xff0000ff", fill: "0xff00002e" },
    { outline: "0x2ecc71ff", fill: "0x2ecc7126" },
    { outline: "0x0066ffff", fill: "0x0066ff26" },
  ];

  const overlayItems = [];
  for (let i = 0; i < overlays.length; i += 1) {
    const ov = overlays[i];
    const code = ov?.code || "";
    const name = ov?.name || code || "Overlay";
    const geom = findOverlayGeometry(code);
    const { base } = splitOverlayName(name);
    const baseKey = normalizeOverlayKey(base);

    const overlayFeature = featureFromGeometry(geom);

    const areaIntersectM2 = computeIntersectionAreaM2(parcelGeom, geom);
    const palette = overlayColorPalette[i % overlayColorPalette.length];
    const overlayLookupKeys = overlayLookupKeysForName(base);
    const isAirportOverlay =
      baseKey === normalizeOverlayKey("Airport environs overlay");
    const isBicycleOverlay =
      baseKey === normalizeOverlayKey("Bicycle network overlay");
    const isCriticalOverlay =
      overlayLookupKeys.includes(
        normalizeOverlayKey(
          "Critical infrastructure and movement areas overlay",
        ),
      ) ||
      overlayLookupKeys.includes(
        normalizeOverlayKey(
          "Critical infrastructure and movement network overlay",
        ),
      );

    const overlayColor = isAirportOverlay
      ? "0x2962ffff"
      : isBicycleOverlay
        ? "0xffc107ff"
        : isCriticalOverlay
          ? "0xff3b3bff"
          : palette.outline;
    const overlayZoom = isAirportOverlay ? 14 : 19;
    const overlayPaddingPx = isAirportOverlay ? 84 : 110;

    const airportPansGeom = findOverlayGeometry("overlay_airport_pans");
    const airportBlueGeom =
      findOverlayGeometry("overlay_airport_ols") ||
      findOverlayGeometry("overlay_airport_height");
    const airportOverlayLayers = isAirportOverlay
      ? [
          {
            geoJson: featureFromGeometry(airportPansGeom),
            color: "0xffeb3bff",
            fill: "0x00000000",
            weight: 3,
            includeHoles: true,
          },
          {
            geoJson: featureFromGeometry(airportBlueGeom),
            color: "0x2962ffff",
            fill: "0x00000000",
            weight: 3,
            includeHoles: true,
          },
        ].filter((x) => x.geoJson)
      : null;

    const criticalHatchGeoJson = isCriticalOverlay
      ? buildCriticalOverlayHatchGeoJson(parcelGeom, center)
      : null;
    const criticalOverlayLayers = isCriticalOverlay
      ? [
          {
            geoJson: criticalHatchGeoJson,
            color: "0xff3b3bcc",
            fill: "0x00000000",
            weight: 1,
            maxLines: 140,
            preserveLineOrder: true,
            spreadLines: true,
          },
        ].filter((x) => x.geoJson)
      : null;

    const customOverlayLayers = isAirportOverlay
      ? airportOverlayLayers
      : isCriticalOverlay
        ? criticalOverlayLayers
        : null;
    const hasCustomOverlayLayers =
      Array.isArray(customOverlayLayers) && customOverlayLayers.length > 0;
    const pansNearDebug = isAirportOverlay
      ? nearestOverlayBoundaryPoint(center, airportPansGeom)
      : null;
    const blueNearDebug = isAirportOverlay
      ? nearestOverlayBoundaryPoint(center, airportBlueGeom)
      : null;
    const mapCenter = isAirportOverlay
      ? deriveAirportMapCenter(center, airportPansGeom, airportBlueGeom)
      : center;

    if (isAirportOverlay) {
      const airportCodesInSnapshot = overlayPolygons
        .filter((x) => String(x?.code || "").startsWith("overlay_airport_"))
        .map((x) => x?.code);
      console.info("[townplanner_v2][airport_overlay_debug] inputs", {
        overlayName: name,
        overlayCode: code,
        center,
        mapCenter,
        overlayZoom,
        overlayPaddingPx,
        airportCodesInSnapshot,
        hasAirportOverlayLayers: hasCustomOverlayLayers,
        airportOverlayLayerCount: airportOverlayLayers?.length || 0,
        pansGeom: geometryDebugStats(airportPansGeom),
        blueGeom: geometryDebugStats(airportBlueGeom),
        pansNear: pansNearDebug
          ? {
              lat: Number(pansNearDebug.lat?.toFixed(6)),
              lng: Number(pansNearDebug.lng?.toFixed(6)),
              distKm: Number(pansNearDebug.distKm?.toFixed(6)),
            }
          : null,
        blueNear: blueNearDebug
          ? {
              lat: Number(blueNearDebug.lat?.toFixed(6)),
              lng: Number(blueNearDebug.lng?.toFixed(6)),
              distKm: Number(blueNearDebug.distKm?.toFixed(6)),
            }
          : null,
      });
    }

    let usedParcelFallback = false;
    let mapBuffer =
      parcelFeature && (overlayFeature || hasCustomOverlayLayers)
        ? await getParcelOverlayMapImageBufferV2({
            apiKey,
            center: mapCenter,
            parcelGeoJson: parcelFeature,
            overlayGeoJson: overlayFeature,
            overlayLayers: customOverlayLayers,
            debugLabel: isAirportOverlay
              ? "airport-overlay"
              : isCriticalOverlay
                ? "critical-overlay"
                : null,
            parcelColor: "0xffeb3bff",
            parcelFill: isCriticalOverlay ? "0xffeb3b4d" : "0x00000000",
            parcelWeight: 4,
            overlayColor,
            overlayFill: "0x00000000",
            overlayWeight: isAirportOverlay ? 2 : 3,
            zoom: overlayZoom,
            fitToParcel: true,
            paddingPx: overlayPaddingPx,
            maptype: "hybrid",
            size: "640x360",
            scale: 2,
          }).catch(() => null)
        : null;

    // Some overlays can be non-polygon or too large to render reliably as
    // parcel+overlay; ensure we still show the parcel map instead of blank.
    if (!mapBuffer && parcelFeature) {
      usedParcelFallback = true;
      if (isAirportOverlay) {
        console.warn(
          "[townplanner_v2][airport_overlay_debug] overlay map render returned null; using parcel-only fallback",
          {
            center,
            mapCenter,
            overlayCode: code,
          },
        );
      }
      mapBuffer = await getParcelMapImageBufferV2({
        apiKey,
        center: mapCenter,
        parcelGeoJson: parcelFeature,
        parcelColor: "0xffeb3bff",
        parcelFill: isCriticalOverlay ? "0xffeb3b4d" : "0x00000000",
        parcelWeight: 4,
        zoom: isAirportOverlay ? overlayZoom : 19,
        maptype: "hybrid",
        size: "640x360",
        scale: 2,
      }).catch(() => null);
    }

    if (isAirportOverlay) {
      console.info("[townplanner_v2][airport_overlay_debug] map result", {
        overlayCode: code,
        usedFallbackParcelMap: usedParcelFallback,
        hasBuffer: !!mapBuffer,
        mapBufferBytes: mapBuffer?.length || 0,
      });
    }

    let narrativeSummary = "";
    const cautions = narrative?.sections?.find((s) => s?.id === "cautions");
    if (cautions?.items?.length) {
      const hit = cautions.items.find((it) =>
        String(it?.title || "")
          .toLowerCase()
          .includes(String(name).toLowerCase()),
      );
      narrativeSummary = hit?.summary || "";
    }

    overlayItems.push({
      name,
      code,
      severity: ov?.severity || "",
      areaIntersectM2,
      mapBuffer,
      narrativeSummary,
    });
  }

  const overlayNamePriority = [
    "Airport environs overlay",
    "Bicycle network overlay",
    "Critical infrastructure and movement areas overlay",
    "Streetscape hierarchy overlay",
    "Dwelling house character overlay",
    "Road hierarchy overlay",
  ].map((v) => normalizeOverlayKey(v));
  const overlayCodePriority = [
    "overlay_airport_pans",
    "overlay_bicycle_network",
    "overlay_critical_infrastructure_movement",
    "overlay_streetscape_hierarchy",
    "character_dwelling_house",
    "overlay_road_hierarchy",
  ];
  const overlayRank = (item) => {
    const baseKey = normalizeOverlayKey(splitOverlayName(item?.name).base);
    const nameIdx = overlayNamePriority.indexOf(baseKey);
    if (nameIdx >= 0) return nameIdx;
    const codeIdx = overlayCodePriority.indexOf(String(item?.code || ""));
    if (codeIdx >= 0) return overlayNamePriority.length + codeIdx;
    return Number.MAX_SAFE_INTEGER;
  };
  const orderedOverlayItems = overlayItems.length
    ? [...overlayItems].sort((a, b) => {
        const rankDiff = overlayRank(a) - overlayRank(b);
        if (rankDiff !== 0) return rankDiff;
        const aSplit = splitOverlayName(a?.name);
        const bSplit = splitOverlayName(b?.name);
        const aBase = normalizeOverlayKey(aSplit.base);
        const bBase = normalizeOverlayKey(bSplit.base);
        if (aBase && aBase === bBase) {
          const detailRank = (detail) => {
            const d = normalizeOverlayKey(detail);
            if (/procedures for air navigation surfaces/.test(d)) return 0;
            if (/local cycle route/.test(d)) return 1;
            if (/ols boundary/.test(d)) return 2;
            return 3;
          };
          const detailDiff =
            detailRank(aSplit.detail) - detailRank(bSplit.detail);
          if (detailDiff !== 0) return detailDiff;
        }
        return String(a?.name || "").localeCompare(String(b?.name || ""));
      })
    : [];

  // Keep one card per base overlay type (e.g. keep a single Airport environs overlay
  // card even if multiple airport subcategories are present in inputs).
  const seenOverlayBases = new Set();
  const displayOverlayItems = [];
  for (const item of orderedOverlayItems) {
    const baseKey = normalizeOverlayKey(splitOverlayName(item?.name).base);
    if (baseKey && seenOverlayBases.has(baseKey)) continue;
    if (baseKey) seenOverlayBases.add(baseKey);
    displayOverlayItems.push(item);
  }

  const zoningAssessmentConsiderations = [
    {
      heading: "Material change of use considerations",
      ref: buildAssessmentRef(assessmentRefs?.material, "5.5.1"),
    },
    {
      heading: "Reconfiguring a lot considerations",
      ref: buildAssessmentRef(assessmentRefs?.reconfiguring, "5.6.1"),
    },
    {
      heading: "Building work considerations",
      ref: buildAssessmentRef(assessmentRefs?.building, "5.7.1"),
    },
    {
      heading: "Operational work considerations",
      ref: buildAssessmentRef(assessmentRefs?.operational, "5.8.1"),
    },
  ];

  // Pagination plan
  const overlayPages = Math.max(1, displayOverlayItems.length);
  const toc = [
    { label: "Cover", page: 1 },
    { label: "Contents", page: 2 },
    { label: "Site overview", page: 3 },
    { label: "Zoning", page: 4 },
    { label: "Overlay constrains", page: 5 },
    { label: "Development controls", page: 5 + overlayPages },
    { label: "References & disclaimer", page: 6 + overlayPages },
  ];

  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true,
  });

  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ========== PAGE 1: COVER ==========
  {
    const x = X(doc);
    const y = Y(doc);
    const w = contentW(doc);

    // Hero band
    doc.save();
    rr(doc, x, y, w, 170, 20);
    doc.fillColor(BRAND.teal).fill();
    doc.restore();

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, x + 18, y + 22, { height: 26 });
      } catch {}
    } else {
      doc
        .fillColor(BRAND.white)
        .font("Helvetica-Bold")
        .fontSize(22)
        .text("sophiaAi", x + 18, y + 18);
    }

    doc
      .fillColor(BRAND.white)
      .font("Helvetica-Bold")
      .fontSize(24)
      .text("Property Planning Report", x + 18, y + 70, { width: w - 36 });

    boundedText(doc, addressLabel, x + 18, y + 104, w - 36, 28, {
      font: "Helvetica",
      fontSize: 11,
      color: BRAND.white,
      lineGap: 0,
      ellipsis: true,
    });

    if (lotPlanLine) {
      boundedText(doc, lotPlanLine, x + 18, y + 122, w - 36, 28, {
        font: "Helvetica",
        fontSize: 11,
        color: BRAND.white,
        lineGap: 0,
        ellipsis: true,
      });
    }

    doc
      .fillColor(BRAND.white)
      .font("Helvetica")
      .fontSize(10)
      .text(
        `Generated ${formatDateAU(generatedAt)} • ${schemeVersion}`,
        x + 18,
        lotPlanLine ? y + 140 : y + 122,
        {
          width: w - 36,
        },
      );

    // Hero map (cover fill)
    const mapY = y + 190;
    const mapH = 330;
    if (siteContextMap) {
      doc.save();
      rr(doc, x, mapY, w, mapH, 20);
      doc.clip();
      try {
        doc.image(siteContextMap, x, mapY, { cover: [w, mapH] });
      } catch {
        try {
          doc.image(siteContextMap, x, mapY, { fit: [w, mapH] });
        } catch {}
      }
      doc.restore();
    } else {
      box(doc, x, mapY, w, mapH, { fill: BRAND.light });
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text("Map not available.", x, mapY + mapH / 2 - 6, {
          width: w,
          align: "center",
        });
    }
  }

  // ========== PAGE 2: CONTENTS ==========
  doc.addPage();
  {
    header(doc, { title: "Contents", addressLabel, schemeVersion, logoBuffer });

    const x = X(doc);
    const w = contentW(doc);
    const top = Y(doc) + 78;

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("Report contents", x, top);

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text("Sections included in this report.", x, top + 26, { width: w });

    const listY = top + 64;
    box(doc, x, listY, w, 520);

    const rowLeftX = x + 18;
    const pageRightX = x + w - 18;
    const leaderMinGap = 10;

    let y = listY + 22;

    for (const row of toc) {
      // label
      doc.fillColor(BRAND.text).font("Helvetica-Bold").fontSize(11);
      doc.text(row.label, rowLeftX, y);

      const labelWidth = doc.widthOfString(row.label);
      const leaderStart = rowLeftX + labelWidth + leaderMinGap;
      const leaderEnd = pageRightX - 24;

      // dotted leader as dashed stroke (no wrapping)
      if (leaderEnd > leaderStart + 20) {
        doc.save();
        doc
          .strokeColor(BRAND.border)
          .lineWidth(1)
          .dash(1, { space: 3 })
          .moveTo(leaderStart, y + 10)
          .lineTo(leaderEnd, y + 10)
          .stroke();
        doc.undash();
        doc.restore();
      }

      // page number
      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(String(row.page), pageRightX - 2, y, {
          width: 20,
          align: "right",
        });

      y += 32;
    }

    boundedText(
      doc,
      "Maps are indicative only. For authoritative mapping and controls, verify against Brisbane City Plan mapping and relevant codes.",
      x,
      listY + 520 - 44,
      w,
      36,
      {
        font: "Helvetica",
        fontSize: 9,
        color: BRAND.muted,
        align: "center",
        ellipsis: true,
      },
    );
  }

  // ========== PAGE 3: SITE OVERVIEW ==========
  doc.addPage();
  {
    header(doc, {
      title: "Site overview",
      addressLabel,
      schemeVersion,
      logoBuffer,
    });

    const x = X(doc);
    const w = contentW(doc);
    const top = Y(doc) + 84;

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("Site overview", x, top);

    // Map should fill container (cover) to remove right whitespace
    const mapY = top + 50;
    const mapH = 270;
    drawCoverImageInRoundedBox(doc, parcelRoadMap, x, mapY, w, mapH, 14);

    const tilesY = mapY + mapH + 16;
    const gap = 12;
    const colW = (w - gap) / 2;
    const colH = 260;

    const zoningText = planningSnapshot?.zoning || "Not mapped";
    const zoningCode = planningSnapshot?.zoningCode || "N/A";
    const zoneDisplay = (() => {
      const code = String(zoningCode || "").trim();
      const text = String(zoningText || "").trim();
      if (!code && !text) return "Not mapped";
      if (code && text) {
        const lc = code.toLowerCase();
        if (text.toLowerCase().startsWith(lc)) return text;
        return `${code} - ${text.replace(/^[–-]\s*/, "")}`;
      }
      return text || code;
    })();

    const np = planningSnapshot?.neighbourhoodPlan || "Not mapped";
    const precinct = planningSnapshot?.neighbourhoodPlanPrecinct || "N/A";

    const npKey = String(np || "")
      .trim()
      .toLowerCase();
    const npSource = sources.find(
      (s) =>
        s?.neighbourhoodPlan &&
        npKey &&
        String(s.neighbourhoodPlan).toLowerCase() === npKey,
    );
    const npRef = assessmentRefs?.neighbourhoodPlan || null;
    const npTableText =
      canonicalCitation(npRef?.sourceCitation) ||
      canonicalCitation(npSource?.sourceCitation || npSource?.label) ||
      "Not mapped";
    const npTableUrl = npRef?.sourceUrl || npSource?.sourceUrl || null;

    const leftX = x;
    const rightX = x + colW + gap;

    const leftTopH = 90;
    const leftBottomH = colH - leftTopH - gap;

    box(doc, leftX, tilesY, colW, leftTopH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Zoning", leftX + 14, tilesY + 12);
    boundedText(doc, "Zone", leftX + 14, tilesY + 34, colW - 28, 14, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: false,
    });
    boundedText(
      doc,
      String(zoneDisplay),
      leftX + 14,
      tilesY + 48,
      colW - 28,
      60,
      {
        font: "Helvetica-Bold",
        fontSize: 11,
        color: BRAND.text,
        ellipsis: true,
      },
    );

    const npY = tilesY + leftTopH + gap;
    box(doc, leftX, npY, colW, leftBottomH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Neighbourhood plan", leftX + 14, npY + 12);
    boundedText(
      doc,
      "Neighbourhood plan",
      leftX + 14,
      npY + 34,
      colW - 28,
      14,
      {
        font: "Helvetica",
        fontSize: 9,
        color: BRAND.muted,
        ellipsis: false,
      },
    );
    boundedText(doc, String(np), leftX + 14, npY + 48, colW - 28, 22, {
      font: "Helvetica-Bold",
      fontSize: 11,
      color: BRAND.text,
      ellipsis: true,
    });
    boundedText(
      doc,
      "Table of assessment",
      leftX + 14,
      npY + 76,
      colW - 28,
      14,
      {
        font: "Helvetica",
        fontSize: 9,
        color: BRAND.muted,
        ellipsis: false,
      },
    );
    if (npTableUrl) {
      doc
        .fillColor(BRAND.link)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(String(npTableText), leftX + 14, npY + 90, {
          width: colW - 28,
          underline: true,
        });
    } else {
      boundedText(
        doc,
        String(npTableText),
        leftX + 14,
        npY + 90,
        colW - 28,
        40,
        {
          font: "Helvetica-Bold",
          fontSize: 9,
          color: BRAND.text,
          ellipsis: false,
        },
      );
    }
    if (npTableUrl) {
      // Make table text clickable
      addExternalLink(doc, leftX + 14, npY + 90, colW - 28, 40, npTableUrl);
    }
    boundedText(doc, "Precinct", leftX + 14, npY + 124, colW - 28, 14, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: false,
    });
    boundedText(doc, String(precinct), leftX + 14, npY + 138, colW - 28, 20, {
      font: "Helvetica-Bold",
      fontSize: 10,
      color: BRAND.text,
      ellipsis: true,
    });

    box(doc, rightX, tilesY, colW, colH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Overlays", rightX + 14, tilesY + 12);

    const listLines = buildOverlayLines(displayOverlayItems, 18);

    boundedText(
      doc,
      listLines.join("\n"),
      rightX + 14,
      tilesY + 34,
      colW - 28,
      colH - 48,
      {
        font: "Helvetica",
        fontSize: 9,
        color: BRAND.muted,
        ellipsis: true,
      },
    );
  }

  // ========== PAGE 4: ZONING ==========
  doc.addPage();
  {
    header(doc, { title: "Zoning", addressLabel, schemeVersion, logoBuffer });

    const x = X(doc);
    const w = contentW(doc);
    const top = Y(doc) + 84;

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("Zone and categories of assessment", x, top);

    const mapY = top + 42;
    const mapH = Math.round((w * 380) / 640);
    drawCoverImageInRoundedBox(doc, zoningMap, x, mapY, w, mapH, 14);

    const noteY = mapY + mapH + 12;
    const noteH = 74;
    box(doc, x, noteY, w, noteH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Notes", x + 14, noteY + 12);

    boundedText(
      doc,
      `Mapped zoning: ${planningSnapshot?.zoning || "Not mapped"}.\nConfirm boundaries and zone intent against Brisbane City Plan mapping and applicable codes.`,
      x + 14,
      noteY + 34,
      w - 28,
      noteH - 34,
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true },
    );

    const drawAssessmentReferenceLine = (label, url, yPos) => {
      const safeLabel = String(label || "Table of assessment");
      const prefix = "Refer ";
      const suffix = " within Brisbane City Plan";
      const safeY = Number.isFinite(yPos) ? yPos : 0;

      doc
        .fillColor(BRAND.text)
        .font("Helvetica")
        .fontSize(10)
        .text(prefix, x, safeY, { lineBreak: false });

      const prefixW = Number(doc.widthOfString(prefix)) || 0;
      doc
        .fillColor(url ? BRAND.link : BRAND.text)
        .font("Helvetica")
        .fontSize(10)
        .text(safeLabel, x + prefixW, safeY, {
          lineBreak: false,
        });

      const labelW = Number(doc.widthOfString(safeLabel)) || 0;
      if (url && labelW > 0) {
        const underlineY = safeY + 11;
        doc
          .save()
          .strokeColor(BRAND.link)
          .lineWidth(0.8)
          .moveTo(x + prefixW, underlineY)
          .lineTo(x + prefixW + labelW, underlineY)
          .stroke()
          .restore();
        addExternalLink(doc, x + prefixW, safeY, labelW, 12, url);
      }

      doc
        .fillColor(BRAND.text)
        .font("Helvetica")
        .fontSize(10)
        .text(suffix, x + prefixW + labelW, safeY, {
          width: Math.max(20, w - prefixW - labelW),
        });
    };

    let sectionY = noteY + noteH + 14;
    for (const item of zoningAssessmentConsiderations) {
      doc.font("Helvetica-Bold").fontSize(12);
      const headingH = doc.heightOfString(item.heading, { width: w });
      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(item.heading, x, sectionY, { width: w });
      sectionY += headingH + 2;
      drawAssessmentReferenceLine(item.ref.label, item.ref.url, sectionY);
      sectionY += 21;
    }

    boundedText(
      doc,
      "Note: the overall category of assessment for a development may change as a result of the Neighbourhood plan or overlays applicable to the site.",
      x,
      sectionY + 2,
      w,
      34,
      {
        font: "Helvetica-Oblique",
        fontSize: 9,
        color: BRAND.text,
        ellipsis: true,
      },
    );
  }

  const overlayAssessmentRefsRaw =
    assessmentRefs && typeof assessmentRefs.overlays === "object"
      ? assessmentRefs.overlays
      : {};
  const overlayAssessmentRefs = {};
  for (const [k, v] of Object.entries(overlayAssessmentRefsRaw)) {
    for (const key of overlayLookupKeysForName(k)) {
      if (!overlayAssessmentRefs[key]) overlayAssessmentRefs[key] = v;
    }
  }

  const resolveOverlayAssessmentRef = (overlayBaseName) => {
    const lookupKeys = overlayLookupKeysForName(overlayBaseName);
    for (const key of lookupKeys) {
      const mapped = overlayAssessmentRefs[key] || null;
      if (!mapped) continue;
      const number = parseTableNumber(mapped?.sourceCitation);
      return {
        label: number ? `Table of assessment ${number}` : "Table of assessment",
        url: mapped?.sourceUrl || null,
      };
    }

    const src = sources.find((s) => {
      const np = normalizeOverlayKey(s?.neighbourhoodPlan);
      if (!np || !lookupKeys.includes(np)) return false;
      const citation = String(s?.sourceCitation || s?.label || "");
      return /5\.10\./.test(citation);
    });

    const number = parseTableNumber(src?.sourceCitation || src?.label);
    return {
      label: number ? `Table of assessment ${number}` : "Table of assessment",
      url: src?.sourceUrl || null,
    };
  };

  const drawReferLine = (label, url, xPos, yPos, maxWidth) => {
    const safeLabel = String(label || "Table of assessment");
    const safeY = Number.isFinite(yPos) ? yPos : 0;
    const prefix = "Refer ";
    const suffix = " within Brisbane City Plan.";

    doc
      .fillColor(BRAND.text)
      .font("Helvetica")
      .fontSize(10)
      .text(prefix, xPos, safeY, { lineBreak: false });

    const prefixW = Number(doc.widthOfString(prefix)) || 0;
    doc
      .fillColor(url ? BRAND.link : BRAND.text)
      .font("Helvetica")
      .fontSize(10)
      .text(safeLabel, xPos + prefixW, safeY, { lineBreak: false });

    const labelW = Number(doc.widthOfString(safeLabel)) || 0;
    if (url && labelW > 0) {
      const underlineY = safeY + 11;
      doc
        .save()
        .strokeColor(BRAND.link)
        .lineWidth(0.8)
        .moveTo(xPos + prefixW, underlineY)
        .lineTo(xPos + prefixW + labelW, underlineY)
        .stroke()
        .restore();
      addExternalLink(doc, xPos + prefixW, safeY, labelW, 12, url);
    }

    doc
      .fillColor(BRAND.text)
      .font("Helvetica")
      .fontSize(10)
      .text(suffix, xPos + prefixW + labelW, safeY, {
        width: Math.max(20, maxWidth - prefixW - labelW),
      });
  };

  // ========== PAGES 5..: OVERLAY CONSTRAINS (1 per page) ==========
  for (let p = 0; p < overlayPages; p += 1) {
    doc.addPage();
    header(doc, {
      title: "Overlay constrains",
      addressLabel,
      schemeVersion,
      logoBuffer,
    });

    const x = X(doc);
    const w = contentW(doc);
    const top = Y(doc) + 84;

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("Overlay constrains", x, top);
    boundedText(
      doc,
      "Overlay constraints returned by current spatial inputs.",
      x,
      top + 26,
      w,
      18,
      { font: "Helvetica", fontSize: 10, color: BRAND.muted, ellipsis: true },
    );

    const blockTopY = top + 52;
    const blockH = 540;

    const drawOverlayBlock = (item, y) => {
      box(doc, x, y, w, blockH);

      if (!item) {
        doc
          .fillColor(BRAND.muted)
          .font("Helvetica")
          .fontSize(10)
          .text(
            "No overlays identified for this site.",
            x,
            y + blockH / 2 - 6,
            {
              width: w,
              align: "center",
            },
          );
        return;
      }

      const { base, detail } = splitOverlayName(item.name);
      const overlayTitle = String(
        base || item.name || "Overlay constraint",
      ).trim();
      const subRaw = sanitizeOverlaySubcategory(detail || item.severity || "");
      const subcategory = /procedures for air navigation surfaces/i.test(subRaw)
        ? `${subRaw} subcategory.`
        : subRaw || "Not mapped";
      const ref = resolveOverlayAssessmentRef(overlayTitle);

      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(13)
        .text(overlayTitle, x + 14, y + 12, { width: w - 28 });

      const mapY = y + 44;
      const mapH = 304;
      drawCoverImageInRoundedBox(
        doc,
        item.mapBuffer,
        x + 14,
        mapY,
        w - 28,
        mapH,
        10,
      );

      boundedText(doc, "Subcategory", x + 14, mapY + mapH + 14, w - 28, 16, {
        font: "Helvetica-Bold",
        fontSize: 11,
        color: BRAND.text,
        ellipsis: false,
      });

      boundedText(doc, subcategory, x + 14, mapY + mapH + 34, w - 28, 36, {
        font: "Helvetica",
        fontSize: 10,
        color: BRAND.text,
        ellipsis: true,
      });

      boundedText(
        doc,
        "Category of assessment",
        x + 14,
        mapY + mapH + 78,
        w - 28,
        16,
        {
          font: "Helvetica-Bold",
          fontSize: 11,
          color: BRAND.text,
          ellipsis: false,
        },
      );

      drawReferLine(ref.label, ref.url, x + 14, mapY + mapH + 98, w - 28);
    };

    const item = displayOverlayItems[p] || null;
    drawOverlayBlock(item, blockTopY);
  }

  const renderDevelopmentControlsPage = () => {
    doc.addPage();
    {
      header(doc, {
        title: "Development controls",
        addressLabel,
        schemeVersion,
        logoBuffer,
      });

      const x = X(doc);
      const w = contentW(doc);
      const top = Y(doc) + 84;

      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(20)
        .text("Key development controls", x, top);
      boundedText(
        doc,
        "Populated from bcc_planning_controls_v2 where available.",
        x,
        top + 26,
        w,
        18,
        { font: "Helvetica", fontSize: 10, color: BRAND.muted, ellipsis: true },
      );

      const cardY = top + 60;
      const gap = 12;
      const cardW = (w - gap) / 2;
      const cardH = 240;

      const get = (k, fallback = "Not available from provided controls") => {
        const v = mergedControls?.[k];
        return v != null && String(v).trim() !== "" ? String(v) : fallback;
      };

      box(doc, x, cardY, cardW, cardH);
      doc
        .fillColor(BRAND.teal2)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Lot & built form", x + 14, cardY + 12);
      boundedText(
        doc,
        [
          `Maximum building height: ${get("maximumHeight")}`,
          `Maximum site coverage: ${get("maximumSiteCoverage")}`,
          `Plot ratio / GFA: ${get("plotRatio")}`,
          `Density (if applicable): ${get("density")}`,
        ].join("\n"),
        x + 14,
        cardY + 36,
        cardW - 28,
        cardH - 54,
        { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true },
      );

      box(doc, x + cardW + gap, cardY, cardW, cardH);
      doc
        .fillColor(BRAND.teal2)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Subdivision & dimensions", x + cardW + gap + 14, cardY + 12);
      boundedText(
        doc,
        [
          `Minimum lot size: ${get("minimumLotSize")}`,
          `Minimum frontage: ${get("minimumFrontage")}`,
          `Site area (approx.): ${formatAreaM2(areaM2)}`,
          `Coordinates: ${formatCoords(lat, lng)}`,
        ].join("\n"),
        x + cardW + gap + 14,
        cardY + 36,
        cardW - 28,
        cardH - 54,
        { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true },
      );

      const srcY = cardY + cardH + 14;
      box(doc, x, srcY, w, 280);
      doc
        .fillColor(BRAND.teal2)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("Controls sources", x + 14, srcY + 12);

      const srcLines = sources.length
        ? sources
            .slice(0, 8)
            .map(
              (s) =>
                `• ${s.label || "Source"}${s.sourceCitation ? ` — ${s.sourceCitation}` : ""}`,
            )
        : [
            "• No matching control records were returned for this site. Populate bcc_planning_controls_v2 to enrich this section.",
          ];

      boundedText(doc, srcLines.join("\n"), x + 14, srcY + 34, w - 28, 180, {
        font: "Helvetica",
        fontSize: 9,
        color: BRAND.muted,
        ellipsis: true,
      });

      const devBullets =
        narrative?.sections?.find((s) => s?.id === "development")?.bullets ||
        [];
      const note = devBullets.length
        ? devBullets
            .slice(0, 4)
            .map((b) => `• ${b}`)
            .join("\n")
        : "";
      if (note) {
        boundedText(doc, note, x + 14, srcY + 220, w - 28, 50, {
          font: "Helvetica",
          fontSize: 9,
          color: BRAND.muted,
          ellipsis: true,
        });
      }
    }
  };

  // ========== PAGE 5 + overlay pages: DEVELOPMENT CONTROLS ==========
  renderDevelopmentControlsPage();

  // ========== LAST PAGE: REFERENCES & DISCLAIMER ==========
  doc.addPage();
  {
    header(doc, {
      title: "References & disclaimer",
      addressLabel,
      schemeVersion,
      logoBuffer,
    });

    const x = X(doc);
    const w = contentW(doc);
    const top = Y(doc) + 84;

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("References & disclaimer", x, top);

    const bY = top + 50;
    box(doc, x, bY, w, 260);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("References", x + 14, bY + 12);

    const refsFromNarrative =
      narrative?.sections?.find((s) => s?.id === "references")?.items || [];

    const refs = [
      "Brisbane City Plan 2014 (Brisbane City Council).",
      "Brisbane City Plan mapping (Brisbane City Council).",
      ...refsFromNarrative.map((r) => String(r)),
    ].filter(Boolean);

    boundedText(
      doc,
      refs
        .slice(0, 10)
        .map((r) => `• ${r}`)
        .join("\n"),
      x + 14,
      bY + 34,
      w - 28,
      210,
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true },
    );

    const dY = bY + 276;
    box(doc, x, dY, w, 250);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Disclaimer", x + 14, dY + 12);

    const disclaimer =
      narrative?.disclaimer ||
      "This report is based solely on the provided factual inputs and Brisbane City Plan mapping. It does not constitute professional planning advice. Verify requirements against authoritative sources and obtain professional advice for specific development proposals.";

    boundedText(doc, disclaimer, x + 14, dY + 34, w - 28, 160, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: true,
    });

    boundedText(
      doc,
      "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan mapping and applicable codes.",
      x + 14,
      dY + 202,
      w - 28,
      40,
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true },
    );
  }

  // Footers after all pages exist
  footerAllPages(doc, schemeVersion);

  doc.end();
  return done;
}
