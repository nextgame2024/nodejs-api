// townplanner_report_pdf_v2.service.js
import PDFDocument from "pdfkit";
import * as turf from "@turf/turf";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
} from "./googleStaticMaps_v2.service.js";

export const PDF_ENGINE_VERSION = "TPR-PDFKIT-V3-2026-04-03.72";

const VEGETATION_STATE_MAPPING_CODE =
  "state_mapping_sara_regulated_vegetation_management_map";
const VEGETATION_STATE_MAPPING_SOURCE =
  "Queensland Vegetation Management (Biota/VegetationManagement layer 109)";

const DAMS_STATE_TRANSPORT_LAYER_META = [
  {
    code: "dams_state_transport_state_controlled_road",
    layerLabel: "State-controlled road corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_railway_corridor",
    layerLabel: "Railway corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_busway_corridor",
    layerLabel: "Busway corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_light_rail_corridor",
    layerLabel: "Light rail corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_future_state_controlled_road",
    layerLabel: "Future State-controlled road corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_future_railway_corridor",
    layerLabel: "Future railway corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_future_busway_corridor",
    layerLabel: "Future busway corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_future_light_rail_corridor",
    layerLabel: "Future light rail corridor",
    groupLabel: "State transport corridor",
  },
  {
    code: "dams_state_transport_25m_state_controlled_road",
    layerLabel: "Area within 25m of a State-controlled road",
    groupLabel: "Areas within 25m of a state transport corridor",
  },
  {
    code: "dams_state_transport_25m_railway_corridor",
    layerLabel: "Area within 25m of a railway corridor",
    groupLabel: "Areas within 25m of a state transport corridor",
  },
  {
    code: "dams_state_transport_25m_busway_corridor",
    layerLabel: "Area within 25m of a busway corridor",
    groupLabel: "Areas within 25m of a state transport corridor",
  },
  {
    code: "dams_state_transport_25m_light_rail_corridor",
    layerLabel: "Area within 25m of a light rail corridor",
    groupLabel: "Areas within 25m of a state transport corridor",
  },
];

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
function formatLengthM(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  return `${n.toLocaleString("en-AU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} m`;
}
function parseMetersFromValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const raw = String(value);
  const parsed = Number(raw.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function extractPrimaryParcelRing(geometry) {
  if (!geometry || typeof geometry !== "object") return null;
  if (geometry.type === "Polygon") {
    const ring = geometry?.coordinates?.[0];
    return Array.isArray(ring) && ring.length >= 4 ? ring : null;
  }
  if (geometry.type === "MultiPolygon") {
    const polygons = Array.isArray(geometry?.coordinates)
      ? geometry.coordinates
      : [];
    let bestRing = null;
    let bestArea = -Infinity;
    for (const poly of polygons) {
      const ring = Array.isArray(poly?.[0]) ? poly[0] : null;
      if (!ring || ring.length < 4) continue;
      const polygon = featureFromGeometry({
        type: "Polygon",
        coordinates: [ring],
      });
      const area = polygon ? Math.abs(turf.area(polygon)) : 0;
      if (area > bestArea) {
        bestArea = area;
        bestRing = ring;
      }
    }
    return bestRing;
  }
  return null;
}
function ringPerimeterM(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return null;
  let total = 0;
  for (let i = 1; i < ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const km = turf.distance(turf.point(a), turf.point(b), {
      units: "kilometers",
    });
    if (Number.isFinite(km) && km > 0) total += km * 1000;
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (
    Array.isArray(first) &&
    Array.isArray(last) &&
    (first[0] !== last[0] || first[1] !== last[1])
  ) {
    const km = turf.distance(turf.point(last), turf.point(first), {
      units: "kilometers",
    });
    if (Number.isFinite(km) && km > 0) total += km * 1000;
  }
  return total > 0 ? total : null;
}
function estimateLotDimensionsM(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const points = ring.filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  if (points.length < 3) return null;

  const first = points[0];
  const cleaned =
    points.length >= 2 &&
    points[points.length - 1][0] === first[0] &&
    points[points.length - 1][1] === first[1]
      ? points.slice(0, -1)
      : points;
  if (cleaned.length < 3) return null;

  const meanLat =
    cleaned.reduce((sum, p) => sum + p[1], 0) / Math.max(1, cleaned.length);
  const meanLng =
    cleaned.reduce((sum, p) => sum + p[0], 0) / Math.max(1, cleaned.length);
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const meterPoints = cleaned.map((p) => ({
    x: (p[0] - meanLng) * 111320 * cosLat,
    y: (p[1] - meanLat) * 110540,
  }));

  const mx =
    meterPoints.reduce((sum, p) => sum + p.x, 0) /
    Math.max(1, meterPoints.length);
  const my =
    meterPoints.reduce((sum, p) => sum + p.y, 0) /
    Math.max(1, meterPoints.length);

  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const p of meterPoints) {
    const dx = p.x - mx;
    const dy = p.y - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  const denom = Math.max(1, meterPoints.length);
  cxx /= denom;
  cyy /= denom;
  cxy /= denom;

  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const cosT = Math.cos(-theta);
  const sinT = Math.sin(-theta);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of meterPoints) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const xr = dx * cosT - dy * sinT;
    const yr = dx * sinT + dy * cosT;
    if (xr < minX) minX = xr;
    if (xr > maxX) maxX = xr;
    if (yr < minY) minY = yr;
    if (yr > maxY) maxY = yr;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (!(spanX > 0 && spanY > 0)) return null;

  return {
    longSideM: Math.max(spanX, spanY),
    shortSideM: Math.min(spanX, spanY),
  };
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

function buildDashedOverlayLineGeoJson(
  geometry,
  { dashKm = 0.018, gapKm = 0.011, maxSegments = 900 } = {},
) {
  const candidates = lineCandidatesFromGeometry(geometry);
  if (!candidates.length) return null;

  const dash = Math.max(0.002, Number(dashKm) || 0.018);
  const gap = Math.max(0.001, Number(gapKm) || 0.011);
  const limit = Math.max(24, Math.floor(Number(maxSegments) || 900));
  const dashedSegments = [];

  for (const feature of candidates) {
    const g = feature?.geometry || null;
    const parts =
      g?.type === "LineString"
        ? [g.coordinates]
        : g?.type === "MultiLineString"
          ? g.coordinates
          : [];

    for (const coords of parts) {
      if (!Array.isArray(coords) || coords.length < 2) continue;

      let baseLine = null;
      try {
        baseLine = turf.lineString(coords);
      } catch {
        baseLine = null;
      }
      if (!baseLine) continue;

      let totalKm = 0;
      try {
        totalKm = turf.length(baseLine, { units: "kilometers" });
      } catch {
        totalKm = 0;
      }
      if (!(totalKm > 0)) continue;

      for (let startKm = 0; startKm < totalKm; startKm += dash + gap) {
        const endKm = Math.min(totalKm, startKm + dash);
        if (!(endKm > startKm)) continue;
        try {
          const seg = turf.lineSliceAlong(baseLine, startKm, endKm, {
            units: "kilometers",
          });
          const segCoords = seg?.geometry?.coordinates;
          if (Array.isArray(segCoords) && segCoords.length >= 2) {
            dashedSegments.push(segCoords);
            if (dashedSegments.length >= limit) break;
          }
        } catch {}
      }

      if (dashedSegments.length >= limit) break;
    }

    if (dashedSegments.length >= limit) break;
  }

  if (!dashedSegments.length) return featureFromGeometry(geometry);
  return featureFromGeometry({
    type: "MultiLineString",
    coordinates: dashedSegments,
  });
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

function deriveDwellingMapCenter(baseCenter) {
  if (!baseCenter) return null;
  const lat = Number(baseCenter.lat);
  const lng = Number(baseCenter.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // Nudge east slightly so the parcel appears a bit more centered (left in frame).
  return { lat, lng: lng + 0.00035 };
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
  // Use standards-based URI annotation for maximum PDF viewer compatibility.
  const safeUrl = String(url).trim();
  if (!safeUrl) return;

  const uriAction = doc.ref({
    S: "URI",
    URI: new String(safeUrl),
    NewWindow: true,
  });
  uriAction.end();

  doc.annotate(x, y, w, h, {
    Subtype: "Link",
    A: uriAction,
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
  const areaM2Computed = parcelFeature ? turf.area(parcelFeature) : null;
  const lotAreaM2 =
    Number.isFinite(Number(areaM2)) && Number(areaM2) > 0
      ? Number(areaM2)
      : Number.isFinite(Number(areaM2Computed)) && Number(areaM2Computed) > 0
        ? Number(areaM2Computed)
        : null;
  const parcelRing = extractPrimaryParcelRing(parcelGeom);
  const lotPerimeterM = ringPerimeterM(parcelRing);
  const lotDimensions = estimateLotDimensionsM(parcelRing);
  const reportedFrontageM = parseMetersFromValue(
    pickProp(parcelProps, [
      "frontage",
      "frontage_m",
      "road_frontage",
      "street_frontage",
      "street_frontage_m",
      "frontage_length",
      "frontage_length_m",
      "lot_frontage",
      "lot_frontage_m",
    ]),
  );

  const center =
    lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;

  const overlays = Array.isArray(planningSnapshot?.overlays)
    ? planningSnapshot.overlays
    : [];
  const overlayPolygons = Array.isArray(planningSnapshot?.overlayPolygons)
    ? planningSnapshot.overlayPolygons
    : [];
  const stateMappingConsiderations = Array.isArray(
    planningSnapshot?.stateMappingConsiderations,
  )
    ? planningSnapshot.stateMappingConsiderations
    : [];
  const stateMappingPolygons = Array.isArray(
    planningSnapshot?.stateMappingPolygons,
  )
    ? planningSnapshot.stateMappingPolygons
    : [];
  const nonSaraMappingConsiderations = Array.isArray(
    planningSnapshot?.nonSaraMappingConsiderations,
  )
    ? planningSnapshot.nonSaraMappingConsiderations
    : [];
  const nonSaraMappingPolygons = Array.isArray(
    planningSnapshot?.nonSaraMappingPolygons,
  )
    ? planningSnapshot.nonSaraMappingPolygons
    : [];
  const rawStateMappingConsiderations =
    planningSnapshot?.rawStateMappingConsiderations &&
    typeof planningSnapshot.rawStateMappingConsiderations === "object"
      ? planningSnapshot.rawStateMappingConsiderations
      : {};
  const rawNonSaraMappingConsiderations =
    planningSnapshot?.rawNonSaraMappingConsiderations &&
    typeof planningSnapshot.rawNonSaraMappingConsiderations === "object"
      ? planningSnapshot.rawNonSaraMappingConsiderations
      : {};

  const findOverlayGeometry = (code) => {
    const hit = overlayPolygons.find((o) => o?.code === code && o?.geometry);
    return hit?.geometry || null;
  };
  const findStateMappingGeometry = (code) => {
    const hit = stateMappingPolygons.find(
      (o) => o?.code === code && o?.geometry,
    );
    return hit?.geometry || null;
  };
  const findNonSaraGeometry = (code) => {
    const hit = nonSaraMappingPolygons.find(
      (o) => o?.code === code && o?.geometry,
    );
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
      zoomNudge: 2,
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
    const isDamsTransportOverlay = String(code || "").startsWith(
      "dams_state_transport_",
    );
    const isFutureBuswayDamsOverlay =
      String(code || "") === "dams_state_transport_future_busway_corridor";
    const isDwellingOverlay =
      baseKey === normalizeOverlayKey("Dwelling house character overlay");
    const isStreetscapeOverlay =
      baseKey === normalizeOverlayKey("Streetscape hierarchy overlay");
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
        : isDamsTransportOverlay
          ? "0xc2185bff"
          : isDwellingOverlay
            ? "0x00000000"
            : isStreetscapeOverlay
              ? "0xe46e6eff"
              : isCriticalOverlay
                ? "0xff3b3bff"
                : palette.outline;
    const overlayFillColor = isDwellingOverlay
      ? "0xe46e6e66"
      : isDamsTransportOverlay
        ? "0xf8bbd055"
        : "0x00000000";
    const overlayZoom = isAirportOverlay
      ? 14
      : isDwellingOverlay
        ? 18
        : isStreetscapeOverlay
          ? 19
          : 19;
    const overlayPaddingPx = isAirportOverlay
      ? 84
      : isDwellingOverlay
        ? 98
        : isStreetscapeOverlay
          ? 102
          : 110;
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

    const dwellingOverlayLayers = isDwellingOverlay
      ? [
          {
            geoJson: overlayFeature,
            color: "0x00000000",
            fill: "0xe46e6e66",
            weight: 1,
            includeHoles: false,
            maxRings: 24,
          },
        ].filter((x) => x.geoJson)
      : null;

    const streetscapeLineGeoJson = isStreetscapeOverlay ? overlayFeature : null;
    const streetscapeOverlayLayers = isStreetscapeOverlay
      ? [
          {
            geoJson: streetscapeLineGeoJson,
            color: "0xe46e6eff",
            fill: "0x00000000",
            weight: 3,
            maxLines: 260,
            preserveLineOrder: true,
            spreadLines: true,
          },
        ].filter((x) => x.geoJson)
      : null;

    const customOverlayLayers = isAirportOverlay
      ? airportOverlayLayers
      : isCriticalOverlay
        ? criticalOverlayLayers
        : isDwellingOverlay
          ? dwellingOverlayLayers
          : isStreetscapeOverlay
            ? streetscapeOverlayLayers
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
      : isDwellingOverlay
        ? deriveDwellingMapCenter(center)
        : isStreetscapeOverlay
          ? center
          : center;
    const overlayCenter = isDamsTransportOverlay ? null : mapCenter;
    const overlayMapType = isDamsTransportOverlay ? "roadmap" : "hybrid";
    const overlayFitToParcel = isDamsTransportOverlay
      ? false
      : !(isDwellingOverlay || isStreetscapeOverlay);
    const overlayRenderZoom = isDamsTransportOverlay ? 18 : overlayZoom;
    const effectiveDamsZoom = isFutureBuswayDamsOverlay
      ? 17
      : overlayRenderZoom;
    const overlayRenderPadding = isDamsTransportOverlay
      ? Math.max(72, overlayPaddingPx - 18)
      : overlayPaddingPx;
    const overlayStyles = isDamsTransportOverlay
      ? [
          "feature:all|saturation:-100|lightness:18",
          "feature:poi|visibility:off",
          "feature:transit|visibility:off",
          "feature:road|color:0xb8bec6",
          "feature:water|color:0xdde2e8",
        ]
      : null;

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
            center: overlayCenter,
            parcelGeoJson: parcelFeature,
            overlayGeoJson: overlayFeature,
            overlayLayers: customOverlayLayers,
            debugLabel: isAirportOverlay
              ? "airport-overlay"
              : isDamsTransportOverlay
                ? "dams-overlay"
                : isCriticalOverlay
                  ? "critical-overlay"
                  : isDwellingOverlay
                    ? "dwelling-overlay"
                    : isStreetscapeOverlay
                      ? "streetscape-overlay"
                      : null,
            parcelColor: "0xffeb3bff",
            parcelFill:
              isCriticalOverlay || isDwellingOverlay
                ? "0xffeb3b4d"
                : "0x00000000",
            parcelWeight: 4,
            overlayColor,
            overlayFill: overlayFillColor,
            overlayWeight: isDamsTransportOverlay
              ? 4
              : isAirportOverlay
                ? 2
                : 3,
            zoom: effectiveDamsZoom,
            zoomNudge: isDwellingOverlay ? 2 : isStreetscapeOverlay ? 2 : 0,
            fitToParcel: overlayFitToParcel,
            paddingPx: overlayRenderPadding,
            maptype: overlayMapType,
            size: "640x360",
            scale: 2,
            styles: overlayStyles,
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
        parcelFill:
          isCriticalOverlay || isDwellingOverlay ? "0xffeb3b4d" : "0x00000000",
        parcelWeight: 4,
        zoom:
          isAirportOverlay || isDwellingOverlay || isStreetscapeOverlay
            ? overlayZoom
            : 19,
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

  const isDamsTransportCode = (code) =>
    String(code || "").startsWith("dams_state_transport_");
  const nonDamsOverlayItems = overlayItems.filter(
    (item) => !isDamsTransportCode(item?.code),
  );
  const damsOverlayItems = overlayItems.filter((item) =>
    isDamsTransportCode(item?.code),
  );

  const overlayNamePriority = [
    "Airport environs overlay",
    "Bicycle network overlay",
    "Critical infrastructure and movement areas overlay",
    "Dwelling house character overlay",
    "Road hierarchy overlay",
    "Streetscape hierarchy overlay",
  ].map((v) => normalizeOverlayKey(v));
  const overlayCodePriority = [
    "overlay_airport_pans",
    "overlay_bicycle_network",
    "overlay_critical_infrastructure_movement",
    "character_dwelling_house",
    "overlay_road_hierarchy",
    "overlay_streetscape_hierarchy",
  ];
  const overlayRank = (item) => {
    const baseKey = normalizeOverlayKey(splitOverlayName(item?.name).base);
    const nameIdx = overlayNamePriority.indexOf(baseKey);
    if (nameIdx >= 0) return nameIdx;
    const codeIdx = overlayCodePriority.indexOf(String(item?.code || ""));
    if (codeIdx >= 0) return overlayNamePriority.length + codeIdx;
    return Number.MAX_SAFE_INTEGER;
  };
  const orderedOverlayItems = nonDamsOverlayItems.length
    ? [...nonDamsOverlayItems].sort((a, b) => {
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

  const rawDamsStateTransport =
    planningSnapshot?.rawDamsStateTransport &&
    typeof planningSnapshot.rawDamsStateTransport === "object"
      ? planningSnapshot.rawDamsStateTransport
      : {};

  const damsOverlayByCode = new Map(
    damsOverlayItems.map((item) => [String(item?.code || ""), item]),
  );
  const damsTransportItems = [];

  for (const meta of DAMS_STATE_TRANSPORT_LAYER_META) {
    const item = damsOverlayByCode.get(meta.code);
    if (!item) continue;
    const rawProps =
      rawDamsStateTransport && typeof rawDamsStateTransport === "object"
        ? rawDamsStateTransport[meta.code] || null
        : null;
    damsTransportItems.push({
      ...item,
      layerLabel: meta.layerLabel,
      groupLabel: meta.groupLabel,
      rawProps,
    });
  }

  for (const item of damsOverlayItems) {
    const key = String(item?.code || "");
    if (DAMS_STATE_TRANSPORT_LAYER_META.some((meta) => meta.code === key))
      continue;
    const fallbackName =
      splitOverlayName(item?.name).detail || item?.name || key;
    damsTransportItems.push({
      ...item,
      layerLabel: fallbackName,
      groupLabel: "State transport corridor",
      rawProps:
        rawDamsStateTransport && typeof rawDamsStateTransport === "object"
          ? rawDamsStateTransport[key] || null
          : null,
    });
  }

  const stateMappingItems = [];
  const seenStateMappingCodes = new Set();
  for (const rawItem of stateMappingConsiderations) {
    const code = String(rawItem?.code || "").trim();
    if (!code || seenStateMappingCodes.has(code)) continue;
    seenStateMappingCodes.add(code);

    const geom = findStateMappingGeometry(code);
    const overlayFeature = featureFromGeometry(geom);
    const sectionTitle =
      String(rawItem?.sectionTitle || "").trim() || "State mapping";
    const sectionKey = normalizeOverlayKey(sectionTitle);
    const style = sectionKey.includes("spp")
      ? { outline: "0x29b6f6ff", fill: "0x29b6f652" }
      : sectionKey.includes("other state")
        ? { outline: "0xf9a825ff", fill: "0xf9a8254d" }
        : { outline: "0xff8a65ff", fill: "0xff8a654d" };

    const rawPropsForCode =
      rawStateMappingConsiderations &&
      typeof rawStateMappingConsiderations === "object"
        ? rawStateMappingConsiderations[code] || null
        : null;

    const seqRegionalPlanCode =
      "state_mapping_sara_seq_regional_plan_land_use_categories";
    const seqCategoryRaw = pickProp(rawPropsForCode, [
      "RLUC2023",
      "RLUC",
      "CATEGORY",
      "TYPE",
      "CLASS",
    ]);
    const seqCategory = String(
      seqCategoryRaw || rawItem?.detail || "",
    )
      .toLowerCase()
      .trim();
    const seqCategoryStyle = (() => {
      if (!seqCategory) return null;
      if (
        seqCategory.includes("regional landscape") ||
        seqCategory.includes("rural production")
      ) {
        return { outline: "0x8d8d8dff", fill: "0xe0e0e0a0" };
      }
      if (seqCategory.includes("rural living"))
        return { outline: "0xf4a300ff", fill: "0xffe9a8a0" };
      if (seqCategory.includes("urban footprint"))
        return { outline: "0xe25a5aff", fill: "0xffb8b8a0" };
      return null;
    })();
    const seqLayerStyle =
      String(code || "") === seqRegionalPlanCode && seqCategoryStyle
        ? seqCategoryStyle
        : null;
    const seqMapStyles = null;
    const seqMapType = "hybrid";

    let mapBuffer =
      parcelFeature && overlayFeature
        ? await getParcelOverlayMapImageBufferV2({
            apiKey,
            center,
            parcelGeoJson: parcelFeature,
            overlayGeoJson: overlayFeature,
            parcelColor: "0xff0000ff",
            parcelFill: "0x00000000",
            parcelWeight: 4,
            overlayColor: (seqLayerStyle || style).outline,
            overlayFill: (seqLayerStyle || style).fill,
            overlayWeight: 2,
            zoom: 19,
            zoomNudge: 2,
            fitToParcel: false,
            paddingPx: 66,
            maptype: seqMapType,
            size: "640x360",
            scale: 2,
            styles: seqMapStyles,
          }).catch(() => null)
        : null;

    if (!mapBuffer && parcelFeature) {
      mapBuffer = await getParcelMapImageBufferV2({
        apiKey,
        center,
        parcelGeoJson: parcelFeature,
        parcelColor: "0xff0000ff",
        parcelFill: "0x00000000",
        parcelWeight: 4,
        zoom: 20,
        maptype: seqMapType,
        size: "640x360",
        scale: 2,
        styles: seqMapStyles,
      }).catch(() => null);
    }

    let detailText = String(rawItem?.detail || "").trim() || "Mapped area";
    let sourceText =
      String(rawItem?.source || "").trim() ||
      "Queensland Development Assessment Mapping System";
    if (code === VEGETATION_STATE_MAPPING_CODE) {
      const rawCategory = pickProp(rawPropsForCode, [
        "rvm_cat",
        "RVM_CAT",
        "CATEGORY",
        "CLASS",
      ]);
      const cat = String(rawCategory || "")
        .trim()
        .toUpperCase();
      if (/^[ABCRX]$/.test(cat)) {
        detailText = `Category ${cat} on the regulated vegetation management map.`;
      } else if (cat) {
        detailText = `${cat} on the regulated vegetation management map.`;
      }
      if (/SARA\/SARA_Data\s*layer\s*5/i.test(sourceText)) {
        sourceText = VEGETATION_STATE_MAPPING_SOURCE;
      }
    }

    stateMappingItems.push({
      code,
      sectionTitle,
      subsectionTitle:
        String(rawItem?.subsectionTitle || "").trim() || "Mapped layer",
      name: String(rawItem?.name || "").trim() || "State mapping layer",
      detail: detailText,
      source: sourceText,
      areaIntersectM2: computeIntersectionAreaM2(parcelGeom, geom),
      mapBuffer,
      rawProps: rawPropsForCode,
    });
  }

  const stateMappingCodePriority = [
    "state_mapping_sara_seq_regional_plan_land_use_categories",
    "state_mapping_sara_water_resource_planning_area_boundaries",
    "state_mapping_sara_regulated_vegetation_management_map",
    "state_mapping_spp_flood_hazard_local_government",
    "state_mapping_rpi_priority_living_area",
  ];
  stateMappingItems.sort((a, b) => {
    const aIdx = stateMappingCodePriority.indexOf(String(a?.code || ""));
    const bIdx = stateMappingCodePriority.indexOf(String(b?.code || ""));
    const left = aIdx >= 0 ? aIdx : Number.MAX_SAFE_INTEGER;
    const right = bIdx >= 0 ? bIdx : Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return String(a?.subsectionTitle || "").localeCompare(
      String(b?.subsectionTitle || ""),
    );
  });

  const vegetationCode = VEGETATION_STATE_MAPPING_CODE;
  if (
    !stateMappingItems.some(
      (item) => String(item?.code || "") === vegetationCode,
    )
  ) {
    const waterCode =
      "state_mapping_sara_water_resource_planning_area_boundaries";
    const waterIdx = stateMappingItems.findIndex(
      (item) => String(item?.code || "") === waterCode,
    );
    const insertAt =
      waterIdx >= 0 ? waterIdx + 1 : Math.min(2, stateMappingItems.length);
    stateMappingItems.splice(insertAt, 0, {
      code: vegetationCode,
      sectionTitle: "SARA DA Mapping",
      subsectionTitle: "Native vegetation clearing",
      name: "Regulated vegetation management map",
      detail: "None identified over the site.",
      source: VEGETATION_STATE_MAPPING_SOURCE,
      areaIntersectM2: null,
      mapBuffer: siteContextMap || parcelRoadMap || null,
      rawProps: null,
    });
  }

  const nonSaraItems = [];
  for (const rawItem of nonSaraMappingConsiderations) {
    const code = String(rawItem?.code || "").trim();
    const geom = code ? findNonSaraGeometry(code) : null;
    const overlayFeature = featureFromGeometry(geom);

    let mapBuffer =
      parcelFeature && overlayFeature
        ? await getParcelOverlayMapImageBufferV2({
            apiKey,
            center,
            parcelGeoJson: parcelFeature,
            overlayGeoJson: overlayFeature,
            parcelColor: "0xff0000ff",
            parcelFill: "0x00000000",
            parcelWeight: 4,
            overlayColor: "0xff6f00ff",
            overlayFill: "0xff6f004d",
            overlayWeight: 2,
            zoom: 19,
            zoomNudge: 2,
            fitToParcel: false,
            paddingPx: 66,
            maptype: "hybrid",
            size: "640x360",
            scale: 2,
          }).catch(() => null)
        : null;

    if (!mapBuffer && parcelFeature) {
      mapBuffer = await getParcelMapImageBufferV2({
        apiKey,
        center,
        parcelGeoJson: parcelFeature,
        parcelColor: "0xff0000ff",
        parcelFill: "0x00000000",
        parcelWeight: 4,
        zoom: 20,
        maptype: "hybrid",
        size: "640x360",
        scale: 2,
      }).catch(() => null);
    }

    nonSaraItems.push({
      code,
      sectionTitle: String(
        rawItem?.sectionTitle || "Non-SARA DA Mapping",
      ).trim(),
      subsectionTitle: String(
        rawItem?.subsectionTitle || rawItem?.name || "Mapped layer",
      ).trim(),
      name: String(rawItem?.name || "Mapped layer").trim(),
      detail: String(rawItem?.detail || "Mapped area").trim(),
      source:
        String(rawItem?.source || "").trim() ||
        "Queensland Development Assessment Mapping System",
      areaIntersectM2: computeIntersectionAreaM2(parcelGeom, geom),
      mapBuffer,
      rawProps:
        rawNonSaraMappingConsiderations &&
        typeof rawNonSaraMappingConsiderations === "object" &&
        code
          ? rawNonSaraMappingConsiderations[code] || null
          : null,
    });
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

  const glossaryFootnote =
    "The above terms are as per Schedule 2 of the Planning Act 2016.";
  const glossaryRows = [
    {
      segments: [{ text: "Development means-", font: "Helvetica-Bold" }],
      afterGap: 2,
    },
    {
      text: `(a) carrying out-
    (i) building work; or
    (ii) plumbing or drainage work; or
    (iii) operational work; or
(b) reconfiguring a lot; or
(c) making a material change of use of premises.`,
      afterGap: 10,
    },
    {
      segments: [
        { text: "Development application", font: "Helvetica-Bold" },
        {
          text: " means an application for a development approval.",
          font: "Helvetica",
        },
      ],
      afterGap: 10,
    },
    {
      segments: [
        { text: "Material change of use,", font: "Helvetica-Bold" },
        {
          text: " of premises, means any of the following that a regulation made under section 284(2)(a) does not prescribe to be minor change of use-",
          font: "Helvetica",
        },
      ],
      afterGap: 2,
    },
    {
      text: `(a) the start of a new use of the premises;
(b) the re-establishment on the premises of a use that has been abandoned;
(c) a material increase in the intensity or scale of the use of the premises.`,
      afterGap: 10,
    },
    {
      segments: [
        { text: "Reconfiguring a lot", font: "Helvetica-Bold" },
        { text: " means-", font: "Helvetica" },
      ],
      afterGap: 2,
    },
    {
      text: `(a) creating lots by subdividing another lot; or
(b) amalgamating 2 or more lots; or
(c) rearranging the boundaries of a lot by registering a plan of subdivision under the Land Act or Land Title Act; or
(d) dividing land into parts by agreement rendering different parts of a lot immediately available for separate disposition or separate occupation, other than by an agreement that is-
    (i) a lease for a term, including renewal options, not exceeding 10 years; or
    (ii) an agreement for the exclusive use of part of the common property for a community titles scheme under the Body Corporate and Community Management Act 1997; or
(e) creating an easement giving access to a lot from a constructed road.`,
      afterGap: 10,
    },
    {
      segments: [{ text: "Building work-", font: "Helvetica-Bold" }],
      afterGap: 2,
    },
    {
      text: `(a) means-
    (i) building, repairing, altering, underpinning (whether by vertical or lateral support), moving or demolishing a building or other structure; or
    (ii) works regulated under the building assessment provisions; or
    (iii) excavating or filling for, or incidental to, the activities stated in subparagraph (i); or
    (iv) excavating or filling that may adversely affect the stability of a building or other structure, whether on the premises on which the building or other structure is situated or on adjacent premises; or
    (v) supporting (vertically or laterally) premises for activities stated in subparagraph (i); and
(b) for a Queensland heritage place, includes-
    (i) altering, repairing, maintaining or moving a built, natural or landscape feature on the place; and
    (ii) excavating, filling or other disturbances to premises that damage, expose or move archaeological artefacts, as defined under the Heritage Act, on the place; and
    (iii) altering, repairing or removing artefacts that contribute to the place's cultural heritage significance (furniture or fittings, for example); and`,
      afterGap: 6,
    },
    {
      text: `    (iv) altering, repairing or removing building finishes that contribute to the place's cultural heritage significance (paint, wallpaper or plaster, for example); and
(c) does not include undertaking-
    (i) operations of any type and all things constructed or installed that allow taking or interfering with water under the Water Act 2000; or
    (ii) tidal works; or
    (iii) works for reconfiguring a lot.`,
      afterGap: 10,
    },
    {
      segments: [
        { text: "Operational work", font: "Helvetica-Bold" },
        {
          text: " means work, other than building work or plumbing or drainage work, in, on, over or under premises that materially affects premises or the use of premises.",
          font: "Helvetica",
        },
      ],
      afterGap: 14,
    },
    {
      text: glossaryFootnote,
      font: "Helvetica-Oblique",
      fontSize: 8.8,
      color: BRAND.muted,
      lineGap: 1,
      afterGap: 14,
    },
    {
      segments: [
        { text: "SARA", font: "Helvetica-Bold", fontSize: 11.2 },
        {
          text: " - State Assessment and Referral Agency",
          font: "Helvetica",
          fontSize: 11.2,
        },
      ],
      afterGap: 0,
    },
  ];

  const glossaryCardMetrics = (pdfDoc) => {
    const top = Y(pdfDoc) + 84;
    const cardY = top + 50;
    const cardH = Math.min(
      570,
      pdfDoc.page.height - pdfDoc.page.margins.bottom - 30 - cardY,
    );
    return {
      cardY,
      cardH,
      textX: X(pdfDoc) + 14,
      textW: contentW(pdfDoc) - 28,
      textStartY: cardY + 16,
      textBottomY: cardY + cardH - 14,
    };
  };

  const measureGlossaryRowHeight = (pdfDoc, row, width) => {
    if (row?.type === "spacer") return Number(row?.height || 8);
    const lineGap = Number.isFinite(row?.lineGap) ? row.lineGap : 0;
    const text = Array.isArray(row?.segments)
      ? row.segments.map((segment) => String(segment?.text || "")).join("")
      : String(row?.text || "");
    const measureFont = row?.font || "Helvetica";
    const measureSize = Number(
      row?.fontSize || row?.segments?.[0]?.fontSize || 10,
    );
    pdfDoc.font(measureFont).fontSize(measureSize);
    return pdfDoc.heightOfString(text, {
      width,
      lineGap,
    });
  };

  const countGlossaryPages = (pdfDoc, rows) => {
    const { textW, textStartY, textBottomY } = glossaryCardMetrics(pdfDoc);
    let pages = 1;
    let cursorY = textStartY;
    for (const row of rows) {
      const rowHeight = measureGlossaryRowHeight(pdfDoc, row, textW);
      const isSpacer = row?.type === "spacer";
      if (cursorY + rowHeight > textBottomY && cursorY > textStartY) {
        pages += 1;
        cursorY = textStartY;
      }
      if (isSpacer) {
        cursorY += rowHeight;
        continue;
      }
      const afterGap = Number.isFinite(row?.afterGap) ? row.afterGap : 8;
      cursorY += rowHeight + afterGap;
    }
    return Math.max(1, pages);
  };

  // Pagination plan
  const overlayPages = Math.max(1, displayOverlayItems.length);
  const stateMappingPages = stateMappingItems.length;
  const damsPages = damsTransportItems.length;
  const glossaryMeasureDoc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
  });
  const glossaryPages = countGlossaryPages(glossaryMeasureDoc, glossaryRows);
  glossaryMeasureDoc.end();

  const nonSaraPages = nonSaraItems.length;
  const tocRowStyle = (level) => {
    if (level === 0) {
      return {
        font: "Helvetica-Bold",
        fontSize: 11,
        rowGap: 16,
        indent: 0,
        color: BRAND.text,
      };
    }
    if (level === 1) {
      return {
        font: "Helvetica",
        fontSize: 10,
        rowGap: 13,
        indent: 18,
        color: BRAND.text,
      };
    }
    return {
      font: "Helvetica",
      fontSize: 9,
      rowGap: 11,
      indent: 36,
      color: BRAND.muted,
    };
  };

  const countTocPages = (rows) => {
    const listH = 520;
    const startY = 22;
    const maxY = listH - 20;
    let pages = 1;
    let y = startY;
    for (const row of rows) {
      const style = tocRowStyle(row.level);
      if (y > maxY) {
        pages += 1;
        y = startY;
      }
      y += style.rowGap;
    }
    return Math.max(1, pages);
  };

  const buildSectionPages = (tocPagesCount) => {
    const tocPagesSafe = Math.max(1, Number(tocPagesCount) || 1);
    const siteOverview = 2 + tocPagesSafe;
    const zoningAssessment = siteOverview + 1;
    const overlayStart = zoningAssessment + 1;
    const stateMappingStart =
      stateMappingPages > 0 ? overlayStart + overlayPages : null;
    const nonSaraStart =
      nonSaraPages > 0 ? overlayStart + overlayPages + stateMappingPages : null;
    const damsStart =
      damsPages > 0
        ? overlayStart + overlayPages + stateMappingPages + nonSaraPages
        : null;
    const glossary =
      overlayStart +
      overlayPages +
      stateMappingPages +
      nonSaraPages +
      damsPages;
    const disclaimer = glossary + glossaryPages;

    return {
      tableOfContents: 2,
      tocPages: tocPagesSafe,
      siteOverview,
      zoningAssessment,
      overlayStart,
      stateMappingStart,
      nonSaraStart,
      damsStart,
      glossary,
      disclaimer,
    };
  };

  const buildTocRows = (pages) => {
    const vegetationCode =
      "state_mapping_sara_regulated_vegetation_management_map";
    const vegetationIdx = stateMappingItems.findIndex(
      (item) => String(item?.code || "") === vegetationCode,
    );
    const vegetationPage =
      pages.stateMappingStart && vegetationIdx >= 0
        ? pages.stateMappingStart + vegetationIdx
        : null;

    const stateMappingTocRows =
      stateMappingPages > 0
        ? (() => {
            const rows = [
              {
                label: "State mapping considerations",
                page: pages.stateMappingStart,
                level: 0,
              },
            ];

            let lastSectionKey = "";
            for (let idx = 0; idx < stateMappingItems.length; idx += 1) {
              const item = stateMappingItems[idx];
              const rowPage = (pages.stateMappingStart || 0) + idx;
              const sectionLabel = String(
                item?.sectionTitle || "State mapping",
              ).trim();
              const sectionKey = sectionLabel.toLowerCase();
              if (sectionLabel && sectionKey !== lastSectionKey) {
                rows.push({
                  label: sectionLabel,
                  page: rowPage,
                  level: 1,
                });
                lastSectionKey = sectionKey;
              }

              rows.push({
                label:
                  item?.subsectionTitle || item?.name || "State mapping layer",
                page: rowPage,
                level: 2,
              });

              if (
                nonSaraPages === 0 &&
                vegetationPage &&
                String(item?.code || "") === vegetationCode
              ) {
                rows.push({
                  label: "Non-SARA DA Mapping",
                  page: vegetationPage,
                  level: 2,
                });
              }
            }
            return rows;
          })()
        : [];

    return [
      { label: "Table of contents", page: pages.tableOfContents, level: 0 },
      { label: "Site Overview", page: pages.siteOverview, level: 0 },
      { label: "Lot size and dimensions", page: pages.siteOverview, level: 1 },
      { label: "Zoning", page: pages.siteOverview, level: 1 },
      { label: "Neighbourhood plan", page: pages.siteOverview, level: 1 },
      { label: "Overlays", page: pages.siteOverview, level: 1 },
      {
        label: "Zone and categories of assessment",
        page: pages.zoningAssessment,
        level: 0,
      },
      ...zoningAssessmentConsiderations.map((item) => ({
        label: item.heading,
        page: pages.zoningAssessment,
        level: 1,
      })),
      { label: "Overlay constraints", page: pages.overlayStart, level: 0 },
      ...displayOverlayItems.flatMap((item, idx) => {
        const { base } = splitOverlayName(item?.name);
        const rowPage = pages.overlayStart + idx;
        return [
          { label: base || "Overlay", page: rowPage, level: 1 },
          { label: "Subcategory", page: rowPage, level: 2 },
          { label: "Category of assessment", page: rowPage, level: 2 },
        ];
      }),
      ...stateMappingTocRows,
      ...(nonSaraPages > 0
        ? [
            {
              label: "Non-SARA DA Mapping",
              page: pages.nonSaraStart,
              level: 0,
            },
            ...nonSaraItems.map((item, idx) => ({
              label: item?.subsectionTitle || item?.name || "Mapped item",
              page: (pages.nonSaraStart || 0) + idx,
              level: 1,
            })),
          ]
        : []),
      ...(damsPages > 0
        ? [
            {
              label: "State transport mapping (DAMS)",
              page: pages.damsStart,
              level: 0,
            },
            ...damsTransportItems.map((item, idx) => ({
              label: item.layerLabel || "State transport layer",
              page: (pages.damsStart || 0) + idx,
              level: 1,
            })),
          ]
        : []),
      { label: "Glossary of key terms", page: pages.glossary, level: 0 },
      {
        label: "Disclaimer and references",
        page: pages.disclaimer,
        level: 0,
      },
      { label: "Disclaimer", page: pages.disclaimer, level: 1 },
      { label: "References", page: pages.disclaimer, level: 1 },
    ];
  };

  let tocPages = 1;
  let sectionPages = buildSectionPages(tocPages);
  let tocRows = buildTocRows(sectionPages);
  for (let i = 0; i < 3; i += 1) {
    const needed = countTocPages(tocRows);
    if (needed === tocPages) break;
    tocPages = needed;
    sectionPages = buildSectionPages(tocPages);
    tocRows = buildTocRows(sectionPages);
  }

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
      .text("Property Report", x + 18, y + 70, { width: w - 36 });

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

  // ========== PAGE 2..: CONTENTS ==========
  {
    let tocIndex = 0;
    for (let tocPage = 0; tocPage < tocPages; tocPage += 1) {
      doc.addPage();
      header(doc, {
        title: "Table of contents",
        addressLabel,
        schemeVersion,
        logoBuffer,
      });

      const x = X(doc);
      const w = contentW(doc);
      const top = Y(doc) + 78;

      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(20)
        .text("Table of contents", x, top);

      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text(
          "Sections and page numbers included in this report.",
          x,
          top + 26,
          {
            width: w,
          },
        );

      const listY = top + 64;
      const listH = 520;
      box(doc, x, listY, w, listH);

      const rowLeftX = x + 18;
      const pageNumRightX = x + w - 30;
      const leaderMinGap = 10;
      let y = listY + 22;

      while (tocIndex < tocRows.length) {
        const row = tocRows[tocIndex];
        const style = tocRowStyle(row.level);
        if (y > listY + listH - 20) break;
        const labelX = rowLeftX + style.indent;

        doc.fillColor(style.color).font(style.font).fontSize(style.fontSize);
        doc.text(row.label, labelX, y, { lineBreak: false });

        const labelWidth = doc.widthOfString(row.label);
        const leaderStart = labelX + labelWidth + leaderMinGap;
        const leaderEnd = pageNumRightX - 26;
        if (leaderEnd > leaderStart + 20) {
          doc.save();
          doc
            .strokeColor(BRAND.border)
            .lineWidth(0.8)
            .dash(1, { space: 3 })
            .moveTo(leaderStart, y + 10)
            .lineTo(leaderEnd, y + 10)
            .stroke();
          doc.undash();
          doc.restore();
        }

        doc
          .fillColor(BRAND.text)
          .font("Helvetica-Bold")
          .fontSize(11)
          .text(String(row.page), pageNumRightX - 24, y, {
            width: 24,
            align: "right",
          });

        y += style.rowGap;
        tocIndex += 1;
      }
    }
  }

  // ========== PAGE AFTER TOC: SITE OVERVIEW ==========
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
    const mapY = top + 28;
    const mapH = 190;
    drawCoverImageInRoundedBox(doc, parcelRoadMap, x, mapY, w, mapH, 14);

    const tilesY = mapY + mapH + 12;
    const gap = 12;
    const leftW = (w - gap) * 0.58;
    const rightW = (w - gap) * 0.42;
    const colH = 380;

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
    const rightX = x + leftW + gap;

    const lotCardH = 162;
    const zoneCardH = 72;
    const leftBottomH = colH - lotCardH - zoneCardH - gap * 2;

    const dimsText = lotDimensions
      ? `${formatLengthM(lotDimensions.longSideM)} × ${formatLengthM(lotDimensions.shortSideM)}`
      : "N/A";
    const lotLines = [
      `Lot/Plan: ${lotPlanLine || "N/A"}`,
      `Site area (approx.): ${formatAreaM2(lotAreaM2)}`,
      `Estimated dimensions (approx. envelope): ${dimsText}`,
      `Perimeter (approx.): ${formatLengthM(lotPerimeterM)}`,
      `Coordinates: ${formatCoords(lat, lng)}`,
    ];
    const lotNoteText =
      "Some values in this section are approximate and derived from parcel geometry in City Plan 2014 data. For legal or survey-confirmed dimensions, refer to official cadastral or title records.";

    box(doc, leftX, tilesY, leftW, lotCardH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Lot size and dimensions", leftX + 14, tilesY + 12);
    const lotContentY = tilesY + 34;
    const lotContentH = lotCardH - 34 - 40;
    boundedText(
      doc,
      lotLines.join("\n"),
      leftX + 14,
      lotContentY,
      leftW - 28,
      lotContentH,
      {
        font: "Helvetica",
        fontSize: 9,
        color: BRAND.muted,
        ellipsis: false,
      },
    );
    boundedText(
      doc,
      lotNoteText,
      leftX + 14,
      lotContentY + lotContentH + 4,
      leftW - 28,
      36,
      {
        font: "Helvetica",
        fontSize: 8.5,
        color: BRAND.muted,
        ellipsis: false,
      },
    );

    const zoneY = tilesY + lotCardH + gap;
    box(doc, leftX, zoneY, leftW, zoneCardH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Zone and categories of assessment", leftX + 14, zoneY + 12);
    boundedText(doc, "Zone", leftX + 14, zoneY + 30, leftW - 28, 16, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: false,
    });
    boundedText(
      doc,
      String(zoneDisplay),
      leftX + 14,
      zoneY + 44,
      leftW - 28,
      zoneCardH - 52,
      {
        font: "Helvetica-Bold",
        fontSize: 10,
        color: BRAND.text,
        ellipsis: true,
      },
    );

    const npY = zoneY + zoneCardH + gap;
    box(doc, leftX, npY, leftW, leftBottomH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Neighbourhood plan", leftX + 14, npY + 12);
    boundedText(
      doc,
      "Neighbourhood plan",
      leftX + 14,
      npY + 28,
      leftW - 28,
      12,
      {
        font: "Helvetica",
        fontSize: 8.5,
        color: BRAND.muted,
        ellipsis: false,
      },
    );
    boundedText(doc, String(np), leftX + 14, npY + 40, leftW - 28, 18, {
      font: "Helvetica-Bold",
      fontSize: 10,
      color: BRAND.text,
      ellipsis: true,
    });
    boundedText(
      doc,
      "Table of assessment",
      leftX + 14,
      npY + 60,
      leftW - 28,
      12,
      {
        font: "Helvetica",
        fontSize: 8.5,
        color: BRAND.muted,
        ellipsis: false,
      },
    );
    if (npTableUrl) {
      doc
        .fillColor(BRAND.link)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(String(npTableText), leftX + 14, npY + 72, {
          width: leftW - 28,
          underline: true,
        });
    } else {
      boundedText(
        doc,
        String(npTableText),
        leftX + 14,
        npY + 72,
        leftW - 28,
        18,
        {
          font: "Helvetica-Bold",
          fontSize: 9,
          color: BRAND.text,
          ellipsis: true,
        },
      );
    }
    if (npTableUrl) {
      addExternalLink(doc, leftX + 14, npY + 72, leftW - 28, 18, npTableUrl);
    }
    boundedText(doc, "Precinct", leftX + 14, npY + 92, leftW - 28, 12, {
      font: "Helvetica",
      fontSize: 8.5,
      color: BRAND.muted,
      ellipsis: false,
    });
    boundedText(doc, String(precinct), leftX + 14, npY + 104, leftW - 28, 16, {
      font: "Helvetica-Bold",
      fontSize: 10,
      color: BRAND.text,
      ellipsis: true,
    });

    box(doc, rightX, tilesY, rightW, colH);
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
      rightW - 28,
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
    header(doc, {
      title: "Zone and categories of assessment",
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

  // ========== PAGES 5..: OVERLAY CONSTRAINTS (1 per page) ==========
  for (let p = 0; p < overlayPages; p += 1) {
    doc.addPage();
    header(doc, {
      title: "Overlay constraints",
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
      .text("Overlay constraints", x, top);
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
        base || item.name || "Overlay constraints",
      ).trim();
      const subRaw = sanitizeOverlaySubcategory(detail || item.severity || "");
      const subBase = /^(mapped overlay|not mapped)$/i.test(subRaw || "")
        ? "N/A"
        : subRaw || "N/A";
      const subcategory = /procedures for air navigation surfaces/i.test(
        subBase,
      )
        ? `${subBase} subcategory.`
        : subBase;
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

  const renderStateMappingConsiderationsPage = (item, index) => {
    doc.addPage();
    header(doc, {
      title: "State mapping considerations",
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
      .text("State mapping considerations", x, top);
    const showIntroText = index === 0;
    if (showIntroText) {
      boundedText(
        doc,
        "The following mapping can assist in identifying State planning considerations including but not limited to development assessment triggers and referrals under the Planning Regulation 2017.",
        x,
        top + 26,
        w,
        32,
        { font: "Helvetica", fontSize: 10, color: BRAND.muted, ellipsis: true },
      );
      boundedText(
        doc,
        "Note, the following mapping is provided for information purposes only, and should be read in conjunction with relevant legislation, plans and frameworks.",
        x,
        top + 58,
        w,
        34,
        {
          font: "Helvetica-Oblique",
          fontSize: 9,
          color: BRAND.text,
          ellipsis: false,
        },
      );
    }

    const blockTopY = showIntroText ? top + 100 : top + 42;
    const blockH = showIntroText ? 492 : 550;
    box(doc, x, blockTopY, w, blockH);

    const sectionTitle = String(item?.sectionTitle || "State mapping");
    const subsectionTitle = String(
      item?.subsectionTitle || item?.name || "Layer",
    );
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text(sectionTitle, x + 14, blockTopY + 12, { width: w - 28 });
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(subsectionTitle, x + 14, blockTopY + 34, { width: w - 28 });

    const mapY = blockTopY + 58;
    const mapH = 280;
    drawCoverImageInRoundedBox(
      doc,
      item?.mapBuffer || null,
      x + 14,
      mapY,
      w - 28,
      mapH,
      10,
    );
    if (!item?.mapBuffer) {
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text("Map not available.", x + 14, mapY + mapH / 2 - 6, {
          width: w - 28,
          align: "center",
        });
    }

    boundedText(doc, "Layers", x + 14, mapY + mapH + 14, w - 28, 16, {
      font: "Helvetica-Bold",
      fontSize: 11,
      color: BRAND.text,
      ellipsis: false,
    });

    const nameLine = String(item?.name || "State mapping layer").trim();
    const detailLine = String(item?.detail || "").trim();
    const normalizeLine = (v) =>
      String(v || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const layerLines = [];
    if (detailLine) {
      const nameNorm = normalizeLine(nameLine);
      const detailNorm = normalizeLine(detailLine);
      if (nameNorm && detailNorm && detailNorm.startsWith(nameNorm)) {
        layerLines.push(detailLine);
      } else {
        if (nameLine) layerLines.push(nameLine);
        layerLines.push(detailLine);
      }
    } else if (nameLine) {
      layerLines.push(nameLine);
    }

    const areaLabel = formatAreaM2(item?.areaIntersectM2);
    if (areaLabel !== "N/A") {
      layerLines.push(`Approx. intersected area: ${areaLabel}`);
    }

    const layersText = layerLines.join("\n");
    const layersTextY = mapY + mapH + 34;
    const layersTextMaxH = 86;
    doc.font("Helvetica").fontSize(10);
    const measuredLayersH = doc.heightOfString(layersText || " ", {
      width: w - 28,
      lineGap: 0,
    });
    const renderedLayersH = Math.max(
      12,
      Math.min(layersTextMaxH, measuredLayersH),
    );
    boundedText(doc, layersText, x + 14, layersTextY, w - 28, layersTextMaxH, {
      font: "Helvetica",
      fontSize: 10,
      color: BRAND.text,
      ellipsis: true,
    });

    const sourceText = `Source: ${String(
      item?.source || "Queensland Development Assessment Mapping System",
    )}`;
    const sourceY = layersTextY + renderedLayersH + 4;
    boundedText(doc, sourceText, x + 14, sourceY, w - 28, 24, {
      font: "Helvetica-Oblique",
      fontSize: 8.6,
      color: BRAND.muted,
      ellipsis: true,
    });

    const isNativeVegetation =
      String(item?.code || "") ===
      "state_mapping_sara_regulated_vegetation_management_map";
    if (isNativeVegetation && nonSaraPages === 0) {
      const nonSaraTitleY = sourceY + 34;
      boundedText(
        doc,
        "Non-SARA DA Mapping",
        x + 14,
        nonSaraTitleY,
        w - 28,
        22,
        {
          font: "Helvetica-Bold",
          fontSize: 14,
          color: BRAND.text,
          ellipsis: true,
        },
      );
      boundedText(
        doc,
        "None identified over the site.",
        x + 14,
        nonSaraTitleY + 24,
        w - 28,
        18,
        {
          font: "Helvetica",
          fontSize: 10,
          color: BRAND.text,
          ellipsis: true,
        },
      );
    }
  };

  if (stateMappingPages > 0) {
    for (let i = 0; i < stateMappingItems.length; i += 1) {
      renderStateMappingConsiderationsPage(stateMappingItems[i], i);
    }
  }

  const renderNonSaraMappingPage = (item) => {
    doc.addPage();
    header(doc, {
      title: "State mapping considerations",
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
      .text("State mapping considerations", x, top);

    const blockTopY = top + 42;
    const blockH = 550;
    box(doc, x, blockTopY, w, blockH);

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("Non-SARA DA Mapping", x + 14, blockTopY + 12, { width: w - 28 });
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text(
        String(item?.subsectionTitle || item?.name || "Mapped layer"),
        x + 14,
        blockTopY + 34,
        {
          width: w - 28,
        },
      );

    const mapY = blockTopY + 58;
    const mapH = 280;
    drawCoverImageInRoundedBox(
      doc,
      item?.mapBuffer || null,
      x + 14,
      mapY,
      w - 28,
      mapH,
      10,
    );
    if (!item?.mapBuffer) {
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text("Map not available.", x + 14, mapY + mapH / 2 - 6, {
          width: w - 28,
          align: "center",
        });
    }

    boundedText(doc, "Layers", x + 14, mapY + mapH + 14, w - 28, 16, {
      font: "Helvetica-Bold",
      fontSize: 11,
      color: BRAND.text,
      ellipsis: false,
    });

    const lines = [];
    const nameLine = String(item?.name || "").trim();
    const detailLine = String(item?.detail || "").trim();
    if (nameLine) lines.push(nameLine);
    if (detailLine && detailLine.toLowerCase() !== nameLine.toLowerCase()) {
      lines.push(detailLine);
    }
    const areaLabel = formatAreaM2(item?.areaIntersectM2);
    if (areaLabel !== "N/A")
      lines.push(`Approx. intersected area: ${areaLabel}`);

    const nonSaraLayersText = lines.join("\n");
    const nonSaraLayersTextY = mapY + mapH + 34;
    const nonSaraLayersTextMaxH = 86;
    doc.font("Helvetica").fontSize(10);
    const nonSaraMeasuredH = doc.heightOfString(nonSaraLayersText || " ", {
      width: w - 28,
      lineGap: 0,
    });
    const nonSaraRenderedH = Math.max(
      12,
      Math.min(nonSaraLayersTextMaxH, nonSaraMeasuredH),
    );
    boundedText(
      doc,
      nonSaraLayersText,
      x + 14,
      nonSaraLayersTextY,
      w - 28,
      nonSaraLayersTextMaxH,
      {
        font: "Helvetica",
        fontSize: 10,
        color: BRAND.text,
        ellipsis: true,
      },
    );
    const nonSaraSourceY = nonSaraLayersTextY + nonSaraRenderedH + 4;
    boundedText(
      doc,
      `Source: ${String(item?.source || "Queensland Development Assessment Mapping System")}`,
      x + 14,
      nonSaraSourceY,
      w - 28,
      24,
      {
        font: "Helvetica-Oblique",
        fontSize: 8.6,
        color: BRAND.muted,
        ellipsis: true,
      },
    );
  };

  if (nonSaraPages > 0) {
    for (const item of nonSaraItems) {
      renderNonSaraMappingPage(item);
    }
  }

  const formatDamsFieldLabel = (key) =>
    String(key || "")
      .replace(/^_+/, "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (m) => m.toUpperCase());

  const formatDamsFieldValue = (value) => {
    if (value === undefined || value === null || value === "") return "N/A";
    if (typeof value === "number" && Number.isFinite(value)) {
      return value.toLocaleString("en-AU", {
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      });
    }
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return String(value);
  };

  const extractDamsRows = (item) => {
    const baseRows = [
      ["Layer", item?.layerLabel || "N/A"],
      ["Category", item?.groupLabel || "State transport corridor"],
      [
        "Approx. intersected area",
        item?.areaIntersectM2 != null
          ? formatAreaM2(item.areaIntersectM2)
          : "N/A",
      ],
      ["Source", "Queensland DAMS (SARA State Transport)"],
    ];

    const props =
      item?.rawProps && typeof item.rawProps === "object" ? item.rawProps : {};
    const extraRows = Object.entries(props)
      .filter(([k, v]) => {
        if (!k) return false;
        if (String(k).startsWith("__")) return false;
        if (v === undefined || v === null || v === "") return false;
        return true;
      })
      .map(([k, v]) => [formatDamsFieldLabel(k), formatDamsFieldValue(v)])
      .slice(0, 8);

    return [...baseRows, ...extraRows];
  };

  const renderDamsStateTransportPage = (item) => {
    doc.addPage();
    header(doc, {
      title: "State transport mapping (DAMS)",
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
      .text("State transport mapping (DAMS)", x, top);
    boundedText(
      doc,
      "Map and extracted data for Queensland State Transport layers relevant to this property.",
      x,
      top + 26,
      w,
      18,
      { font: "Helvetica", fontSize: 10, color: BRAND.muted, ellipsis: true },
    );

    const blockTopY = top + 52;
    const blockH = 540;
    box(doc, x, blockTopY, w, blockH);

    const sectionTitle =
      item?.layerLabel || item?.name || "State transport layer";
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(sectionTitle, x + 14, blockTopY + 12, { width: w - 28 });

    const mapY = blockTopY + 44;
    const mapH = 286;
    drawCoverImageInRoundedBox(
      doc,
      item?.mapBuffer || null,
      x + 14,
      mapY,
      w - 28,
      mapH,
      10,
    );
    if (!item?.mapBuffer) {
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text("Map not available.", x + 14, mapY + mapH / 2 - 6, {
          width: w - 28,
          align: "center",
        });
    }

    let tableY = mapY + mapH + 12;
    const tableX = x + 14;
    const tableW = w - 28;
    const kW = Math.round(tableW * 0.36);
    const vW = tableW - kW;
    tableY += drawSectionRow(doc, tableX, tableY, tableW, "Layer data");

    const rows = extractDamsRows(item);
    for (const row of rows) {
      const projected = tableRowHeight(
        doc,
        row,
        [kW, vW],
        "Helvetica",
        9,
        TABLE.pad,
      );
      if (tableY + projected > blockTopY + blockH - 12) break;
      tableY += drawTableRow(doc, tableX, tableY, [kW, vW], row, {
        fill: BRAND.white,
        font: "Helvetica",
        fontSize: 9,
      });
    }
  };

  if (damsPages > 0) {
    for (const item of damsTransportItems) {
      renderDamsStateTransportPage(item);
    }
  }

  // ========== NEXT PAGES: GLOSSARY ==========
  const renderGlossaryPageFrame = () => {
    doc.addPage();
    header(doc, {
      title: "Glossary of key terms",
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
      .text("Glossary of key terms", x, top);

    const metrics = glossaryCardMetrics(doc);
    box(doc, x, metrics.cardY, w, metrics.cardH);
    return metrics;
  };

  const drawGlossaryRow = (row, x, y, width) => {
    const lineGap = Number.isFinite(row?.lineGap) ? row.lineGap : 0;
    const defaultColor = row?.color || BRAND.text;
    const defaultFont = row?.font || "Helvetica";
    const defaultFontSize = Number(
      row?.fontSize || row?.segments?.[0]?.fontSize || 10,
    );

    if (Array.isArray(row?.segments) && row.segments.length > 0) {
      row.segments.forEach((segment, idx) => {
        doc
          .fillColor(segment?.color || defaultColor)
          .font(segment?.font || defaultFont)
          .fontSize(Number(segment?.fontSize || defaultFontSize))
          .text(
            String(segment?.text || ""),
            idx === 0 ? x : undefined,
            idx === 0 ? y : undefined,
            {
              width,
              lineGap,
              continued: idx < row.segments.length - 1,
            },
          );
      });
      return;
    }

    doc
      .fillColor(defaultColor)
      .font(defaultFont)
      .fontSize(defaultFontSize)
      .text(String(row?.text || ""), x, y, {
        width,
        lineGap,
      });
  };

  let glossaryLayout = renderGlossaryPageFrame();
  let glossaryCursorY = glossaryLayout.textStartY;

  for (const row of glossaryRows) {
    const rowHeight = measureGlossaryRowHeight(doc, row, glossaryLayout.textW);
    const isSpacer = row?.type === "spacer";
    if (
      glossaryCursorY + rowHeight > glossaryLayout.textBottomY &&
      glossaryCursorY > glossaryLayout.textStartY
    ) {
      glossaryLayout = renderGlossaryPageFrame();
      glossaryCursorY = glossaryLayout.textStartY;
    }

    if (isSpacer) {
      glossaryCursorY += rowHeight;
      continue;
    }

    drawGlossaryRow(
      row,
      glossaryLayout.textX,
      glossaryCursorY,
      glossaryLayout.textW,
    );
    const afterGap = Number.isFinite(row?.afterGap) ? row.afterGap : 8;
    glossaryCursorY = doc.y + afterGap;
  }

  // ========== LAST PAGE: DISCLAIMER & REFERENCES ==========
  doc.addPage();
  {
    header(doc, {
      title: "Disclaimer and references",
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
      .text("Disclaimer and references", x, top);

    const bY = top + 50;
    box(doc, x, bY, w, 260);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Disclaimer", x + 14, bY + 12);

    const disclaimer =
      "This report is based solely on the provided factual inputs and the Brisbane City Plan 2014. No other data sources or interpretations have been used. This information is for preliminary guidance only and should not be substituted for professional planning advice. Consult the full Brisbane City Plan 2014 for complete details, along with State and federal mapping resources and applicable legislation. Maps are indicative only.";

    boundedText(doc, disclaimer, x + 14, bY + 34, w - 28, 212, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: true,
    });

    const refsY = bY + 276;
    box(doc, x, refsY, w, 250);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("References", x + 14, refsY + 12);

    const referenceRows = [
      {
        text: "Brisbane City Plan 2014 (Brisbane City Council)",
        font: "Helvetica",
      },
      {
        text: "Brisbane City Plan mapping (Brisbane City Council)",
        font: "Helvetica",
      },
      { text: "Planning Act 2016", font: "Helvetica-Oblique" },
      { text: "Planning Regulation 2017", font: "Helvetica-Oblique" },
      {
        text: "Queensland Government Development Assessment Mapping System",
        font: "Helvetica-Oblique",
      },
    ];

    let refY = refsY + 34;
    for (const row of referenceRows) {
      doc
        .fillColor(BRAND.muted)
        .font(row.font)
        .fontSize(9)
        .text(row.text, x + 14, refY, {
          width: w - 28,
          lineGap: 1,
        });
      refY = doc.y + 8;
      if (refY > refsY + 236) break;
    }
  }

  // Footers after all pages exist
  footerAllPages(doc, schemeVersion);

  doc.end();
  return done;
}
