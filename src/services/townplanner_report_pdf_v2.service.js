// townplanner_report_pdf_v2.service.js
import PDFDocument from "pdfkit";
import * as turf from "@turf/turf";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
} from "./googleStaticMaps_v2.service.js";

export const PDF_ENGINE_VERSION = "TPR-PDFKIT-V3-2026-01-24";

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

const BRAND = {
  teal: "#0F2B2B",
  teal2: "#143838",
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
  { fill = BRAND.light, stroke = BRAND.border, r = 14 } = {}
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

/**
 * PDFKit does NOT clip text to a "height" option. If text exceeds page height,
 * PDFKit will auto-add pages. This helper prevents auto-flow by limiting content.
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
  } = {}
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
    const y = doc.page.height - doc.page.margins.bottom + 18;

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(`Brisbane Town Planner • sophiaAi • ${PDF_ENGINE_VERSION}`, x, y, {
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
  opts = {}
) {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY_SERVER ||
    null;

  const schemeVersion =
    pickFirst(
      reportPayload.schemeVersion,
      reportPayload?.controls?.schemeVersion
    ) ||
    process.env.CITY_PLAN_SCHEME_VERSION ||
    "City Plan 2014";

  const addressLabel =
    pickFirst(
      reportPayload.addressLabel,
      reportPayload.address_label,
      reportPayload?.inputs?.addressLabel,
      reportPayload?.inputs?.address_label
    ) || "Address not provided";

  const placeId =
    pickFirst(reportPayload.placeId, reportPayload?.inputs?.placeId) || "";
  const lat =
    pickFirst(reportPayload.lat, reportPayload?.inputs?.lat, opts.lat) ?? null;
  const lng =
    pickFirst(reportPayload.lng, reportPayload?.inputs?.lng, opts.lng) ?? null;

  const generatedAt =
    pickFirst(
      reportPayload.generatedAt,
      reportPayload?.reportJson?.generatedAt
    ) || new Date().toISOString();

  const logoBuffer = reportPayload.logoBuffer || null;

  const planningSnapshot =
    safeJsonParse(
      pickFirst(
        reportPayload.planningSnapshot,
        reportPayload.planning_snapshot,
        reportPayload.planning,
        reportPayload?.inputs?.planningSnapshot,
        reportPayload?.inputs?.planning_snapshot
      )
    ) || {};

  const controls =
    safeJsonParse(
      pickFirst(reportPayload.controls, reportPayload?.inputs?.controls)
    ) || {};

  const narrative =
    safeJsonParse(
      pickFirst(reportPayload.narrative, reportPayload?.inputs?.narrative)
    ) || null;

  const mergedControls = controls?.mergedControls || {};
  const sources = Array.isArray(controls?.sources) ? controls.sources : [];

  const parcelGeom =
    pickFirst(
      planningSnapshot.siteParcelPolygon,
      planningSnapshot?.propertyParcel?.geometry
    ) || null;

  const zoningGeom =
    pickFirst(
      planningSnapshot.zoningPolygon,
      planningSnapshot?.zoning?.geometry
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

  const zoningMap =
    parcelFeature && zoningFeature
      ? await getParcelOverlayMapImageBufferV2({
          apiKey,
          center,
          parcelGeoJson: parcelFeature,
          overlayGeoJson: zoningFeature,
          overlayColor: "0x00a3ffff",
          overlayFill: "0x00a3ff2e",
          zoom: 17,
          maptype: "roadmap",
          size: "640x420",
          scale: 2,
        }).catch(() => null)
      : null;

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
    const overlayFeature = featureFromGeometry(geom);

    const areaIntersectM2 = computeIntersectionAreaM2(parcelGeom, geom);
    const palette = overlayColorPalette[i % overlayColorPalette.length];

    const mapBuffer =
      parcelFeature && overlayFeature
        ? await getParcelOverlayMapImageBufferV2({
            apiKey,
            center,
            parcelGeoJson: parcelFeature,
            overlayGeoJson: overlayFeature,
            overlayColor: palette.outline,
            overlayFill: palette.fill,
            zoom: 17,
            maptype: "roadmap",
            size: "640x360",
            scale: 2,
          }).catch(() => null)
        : null;

    let narrativeSummary = "";
    const cautions = narrative?.sections?.find((s) => s?.id === "cautions");
    if (cautions?.items?.length) {
      const hit = cautions.items.find((it) =>
        String(it?.title || "")
          .toLowerCase()
          .includes(String(name).toLowerCase())
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

  // Pagination plan
  const overlayPages = Math.max(1, Math.ceil(overlayItems.length / 2));
  const toc = [
    { label: "Cover", page: 1 },
    { label: "Contents", page: 2 },
    { label: "Executive summary", page: 3 },
    { label: "Zoning", page: 4 },
    { label: "Development controls", page: 5 },
    { label: "Potential cautions", page: 6 },
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

    doc
      .fillColor(BRAND.white)
      .font("Helvetica")
      .fontSize(11)
      .text(addressLabel, x + 18, y + 104, { width: w - 36 });

    doc
      .fillColor(BRAND.white)
      .font("Helvetica")
      .fontSize(10)
      .text(
        `Generated ${formatDateAU(generatedAt)} • ${schemeVersion}`,
        x + 18,
        y + 126,
        { width: w - 36 }
      );

    doc
      .fillColor(BRAND.white)
      .font("Helvetica")
      .fontSize(9)
      .text(PDF_ENGINE_VERSION, x + 18, y + 146, {
        width: w - 36,
        opacity: 0.9,
      });

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

    // Inputs block
    const bY = mapY + mapH + 18;
    box(doc, x, bY, w, 90);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("Report inputs", x + 16, bY + 12);

    // Bounded placeId prevents auto-page creation
    boundedText(
      doc,
      `Place ID: ${placeId || "N/A"}\nCoordinates: ${formatCoords(lat, lng)}`,
      x + 16,
      bY + 32,
      w - 32,
      48,
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true }
    );
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

    // Right margin + number column sizing (prevents numbers hugging leader/edge)
    const numBoxW = 24;
    const rightPad = 12; // breathing room from box border
    const numX = pageRightX - rightPad - numBoxW;

    let y = listY + 22;

    for (const row of toc) {
      // label
      doc.fillColor(BRAND.text).font("Helvetica-Bold").fontSize(11);
      doc.text(row.label, rowLeftX, y);

      const labelWidth = doc.widthOfString(row.label);
      const leaderStart = rowLeftX + labelWidth + leaderMinGap;

      // dotted leader as dashed stroke (stop before number column)
      const leaderEnd = numX - 12;
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

      // page number (aligned with spacing)
      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(String(row.page), numX, y, { width: numBoxW, align: "right" });

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
      }
    );
  }

  // ========== PAGE 3: EXECUTIVE SUMMARY ==========
  doc.addPage();
  {
    header(doc, {
      title: "Executive summary",
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
      .text("Planning summary", x, top);

    // Map should fill container (cover) to remove right whitespace
    const mapY = top + 50;
    const mapH = 270;
    drawCoverImageInRoundedBox(doc, parcelRoadMap, x, mapY, w, mapH, 14);

    const tilesY = mapY + mapH + 16;
    const gap = 12;
    const tileW = (w - gap) / 2;
    const tileH = 140;

    const zoningText = planningSnapshot?.zoning || "Not mapped";
    const zoningCode = planningSnapshot?.zoningCode || "N/A";
    const np = planningSnapshot?.neighbourhoodPlan || "Not mapped";
    const precinct =
      planningSnapshot?.neighbourhoodPlanPrecinct || "Not mapped";

    box(doc, x, tilesY, tileW, tileH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Zoning", x + 14, tilesY + 12);
    boundedText(doc, "Zone code", x + 14, tilesY + 34, tileW - 28, 14, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: false,
    });
    boundedText(doc, String(zoningCode), x + 14, tilesY + 48, tileW - 28, 20, {
      font: "Helvetica-Bold",
      fontSize: 13,
      color: BRAND.text,
      ellipsis: true,
    });
    boundedText(doc, "Zone name", x + 14, tilesY + 74, tileW - 28, 14, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: false,
    });
    boundedText(doc, String(zoningText), x + 14, tilesY + 88, tileW - 28, 44, {
      font: "Helvetica-Bold",
      fontSize: 11,
      color: BRAND.text,
      ellipsis: true,
    });

    box(doc, x + tileW + gap, tilesY, tileW, tileH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Neighbourhood plan", x + tileW + gap + 14, tilesY + 12);
    boundedText(
      doc,
      "Plan",
      x + tileW + gap + 14,
      tilesY + 34,
      tileW - 28,
      14,
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: false }
    );
    boundedText(
      doc,
      String(np),
      x + tileW + gap + 14,
      tilesY + 48,
      tileW - 28,
      34,
      {
        font: "Helvetica-Bold",
        fontSize: 11,
        color: BRAND.text,
        ellipsis: true,
      }
    );
    boundedText(
      doc,
      "Precinct",
      x + tileW + gap + 14,
      tilesY + 84,
      tileW - 28,
      14,
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: false }
    );
    boundedText(
      doc,
      String(precinct),
      x + tileW + gap + 14,
      tilesY + 98,
      tileW - 28,
      34,
      {
        font: "Helvetica-Bold",
        fontSize: 11,
        color: BRAND.text,
        ellipsis: true,
      }
    );

    const cY = tilesY + tileH + 16;
    box(doc, x, cY, w, 130);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Potential cautions (overlays)", x + 14, cY + 12);

    const list = overlayItems.length
      ? overlayItems.slice(0, 6).map((o) => `• ${o.name}`)
      : ["• No overlays returned for this site."];

    boundedText(doc, list.join("\n"), x + 14, cY + 34, w - 28, 86, {
      font: "Helvetica",
      fontSize: 9,
      color: BRAND.muted,
      ellipsis: true,
    });
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
      .text("Zoning map", x, top);

    const mapY = top + 46;
    const mapH = 420;
    drawCoverImageInRoundedBox(doc, zoningMap, x, mapY, w, mapH, 14);

    const noteY = mapY + mapH + 14;
    box(doc, x, noteY, w, 120);
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
      80,
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true }
    );
  }

  // ========== PAGE 5: DEVELOPMENT CONTROLS ==========
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
      { font: "Helvetica", fontSize: 10, color: BRAND.muted, ellipsis: true }
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
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true }
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
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true }
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
              `• ${s.label || "Source"}${s.sourceCitation ? ` — ${s.sourceCitation}` : ""}`
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
      narrative?.sections?.find((s) => s?.id === "development")?.bullets || [];
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

  // ========== PAGES 6..: POTENTIAL CAUTIONS (2 per page) ==========
  for (let p = 0; p < overlayPages; p += 1) {
    doc.addPage();
    header(doc, {
      title: "Potential cautions",
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
      .text("Potential cautions", x, top);
    boundedText(
      doc,
      "Overlays returned by current spatial inputs. Verify against authoritative mapping.",
      x,
      top + 26,
      w,
      18,
      { font: "Helvetica", fontSize: 10, color: BRAND.muted, ellipsis: true }
    );

    const blockTopY = top + 60;
    const blockH = 300;
    const gapY = 18;

    const drawOverlayBlock = (item, y) => {
      box(doc, x, y, w, blockH);

      if (!item) {
        doc
          .fillColor(BRAND.muted)
          .font("Helvetica")
          .fontSize(10)
          .text("No overlays.", x, y + blockH / 2 - 6, {
            width: w,
            align: "center",
          });
        return;
      }

      // Title + meta
      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(item.name, x + 14, y + 12, { width: w - 28 });

      const areaText =
        item.areaIntersectM2 == null
          ? "N/A"
          : `${Math.round(item.areaIntersectM2).toLocaleString("en-AU")} m²`;

      boundedText(
        doc,
        `Overlay code: ${item.code || "N/A"}   •   Intersect area: ${areaText}`,
        x + 14,
        y + 32,
        w - 28,
        16,
        { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true }
      );

      // Two-column layout: map left, text right
      const innerY = y + 54;
      const innerH = 228;
      const innerX = x + 14;
      const innerW = w - 28;
      const colGap = 12;
      const mapW = Math.floor(innerW * 0.62);
      const textW = innerW - mapW - colGap;

      // Map (cover-fill to remove right whitespace)
      drawCoverImageInRoundedBox(
        doc,
        item.mapBuffer,
        innerX,
        innerY,
        mapW,
        innerH,
        12
      );

      // Text panel
      box(doc, innerX + mapW + colGap, innerY, textW, innerH, {
        fill: BRAND.white,
        stroke: BRAND.border,
        r: 12,
      });

      const summary =
        item.narrativeSummary ||
        (item.severity
          ? `Mapped overlay. Notes: ${item.severity}.`
          : "Mapped overlay. Review relevant City Plan codes and mapping legend.");

      boundedText(
        doc,
        "Summary",
        innerX + mapW + colGap + 12,
        innerY + 12,
        textW - 24,
        16,
        {
          font: "Helvetica-Bold",
          fontSize: 10,
          color: BRAND.teal2,
          ellipsis: false,
        }
      );

      boundedText(
        doc,
        summary,
        innerX + mapW + colGap + 12,
        innerY + 32,
        textW - 24,
        innerH - 44,
        {
          font: "Helvetica",
          fontSize: 9,
          color: BRAND.muted,
          ellipsis: true,
        }
      );
    };

    const i1 = overlayItems[p * 2] || null;
    const i2 = overlayItems[p * 2 + 1] || null;

    drawOverlayBlock(i1, blockTopY);
    drawOverlayBlock(i2, blockTopY + blockH + gapY);
  }

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
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true }
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
      { font: "Helvetica", fontSize: 9, color: BRAND.muted, ellipsis: true }
    );
  }

  // Footers after all pages exist
  footerAllPages(doc, schemeVersion);

  doc.end();
  return done;
}
