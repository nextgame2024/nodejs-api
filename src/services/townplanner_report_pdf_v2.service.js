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
function contentH(doc) {
  return doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
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

  // Address line under header band
  doc
    .fillColor(BRAND.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(addressLabel || "", x, y + 46, { width: w });

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

/**
 * IMPORTANT: Always draw within fixed page regions.
 * Never rely on doc.y auto-flow.
 */
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
    planningSnapshot?.propertyParcel?.debug?.areaM2 ??
    planningSnapshot?.propertyParcel?.debug?.areaM2 ??
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

    // Narrative summary fallback
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

    // Hero map
    const mapY = y + 190;
    const mapH = 330;
    if (siteContextMap) {
      doc.save();
      rr(doc, x, mapY, w, mapH, 20);
      doc.clip();
      try {
        doc.image(siteContextMap, x, mapY, { fit: [w, mapH] });
      } catch {}
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
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        `Place ID: ${placeId || "N/A"}\nCoordinates: ${formatCoords(lat, lng)}`,
        x + 16,
        bY + 32,
        { width: w - 32, height: 60 }
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

    let y = listY + 18;
    for (const row of toc) {
      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(row.label, x + 18, y, { continued: true });
      // dot leaders (drawn as text for simplicity but bounded)
      const dots = ".".repeat(120);
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text(dots, x + 160, y + 1, { width: w - 230, continued: true });
      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(String(row.page), x, y, { width: w - 18, align: "right" });
      y += 32;
      if (y > listY + 520 - 40) break;
    }

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        "Maps are indicative only. For authoritative mapping and controls, verify against Brisbane City Plan mapping and relevant codes.",
        x,
        listY + 520 - 44,
        { width: w, align: "center" }
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

    const mapY = top + 50;
    const mapH = 270;
    box(doc, x, mapY, w, mapH);
    if (parcelRoadMap) {
      try {
        doc.image(parcelRoadMap, x + 10, mapY + 10, {
          fit: [w - 20, mapH - 20],
        });
      } catch {}
    } else {
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text("Map not available.", x, mapY + mapH / 2 - 6, {
          width: w,
          align: "center",
        });
    }

    // Summary tiles
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
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text("Zone code", x + 14, tilesY + 34);
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(String(zoningCode), x + 14, tilesY + 48);
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text("Zone name", x + 14, tilesY + 74);
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(String(zoningText), x + 14, tilesY + 88, {
        width: tileW - 28,
        height: 40,
      });

    box(doc, x + tileW + gap, tilesY, tileW, tileH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Neighbourhood plan", x + tileW + gap + 14, tilesY + 12);
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text("Plan", x + tileW + gap + 14, tilesY + 34);
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(String(np), x + tileW + gap + 14, tilesY + 48, {
        width: tileW - 28,
        height: 34,
      });
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text("Precinct", x + tileW + gap + 14, tilesY + 84);
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(String(precinct), x + tileW + gap + 14, tilesY + 98, {
        width: tileW - 28,
        height: 34,
      });

    // Cautions list (bounded)
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
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(list.join("\n"), x + 14, cY + 34, { width: w - 28, height: 86 });
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
    box(doc, x, mapY, w, mapH);
    if (zoningMap) {
      try {
        doc.image(zoningMap, x + 10, mapY + 10, { fit: [w - 20, mapH - 20] });
      } catch {}
    } else {
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(10)
        .text("Zoning map not available.", x, mapY + mapH / 2 - 6, {
          width: w,
          align: "center",
        });
    }

    const noteY = mapY + mapH + 14;
    box(doc, x, noteY, w, 120);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Notes", x + 14, noteY + 12);
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        `Mapped zoning: ${planningSnapshot?.zoning || "Not mapped"}.\nConfirm boundaries and zone intent against Brisbane City Plan mapping and applicable codes.`,
        x + 14,
        noteY + 34,
        { width: w - 28, height: 80 }
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
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text(
        "Populated from bcc_planning_controls_v2 where available.",
        x,
        top + 26,
        { width: w }
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
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        [
          `Maximum building height: ${get("maximumHeight")}`,
          `Maximum site coverage: ${get("maximumSiteCoverage")}`,
          `Plot ratio / GFA: ${get("plotRatio")}`,
          `Density (if applicable): ${get("density")}`,
        ].join("\n"),
        x + 14,
        cardY + 36,
        { width: cardW - 28, height: cardH - 50 }
      );

    box(doc, x + cardW + gap, cardY, cardW, cardH);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("Subdivision & dimensions", x + cardW + gap + 14, cardY + 12);
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        [
          `Minimum lot size: ${get("minimumLotSize")}`,
          `Minimum frontage: ${get("minimumFrontage")}`,
          `Site area (approx.): ${formatAreaM2(areaM2)}`,
          `Coordinates: ${formatCoords(lat, lng)}`,
        ].join("\n"),
        x + cardW + gap + 14,
        cardY + 36,
        { width: cardW - 28, height: cardH - 50 }
      );

    // Sources
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

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(srcLines.join("\n"), x + 14, srcY + 34, {
        width: w - 28,
        height: 220,
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
      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(note, x + 14, srcY + 220, { width: w - 28, height: 60 });
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
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text(
        "Overlays returned by current spatial inputs. Verify against authoritative mapping.",
        x,
        top + 26,
        { width: w }
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

      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(item.name, x + 14, y + 12, { width: w - 28, height: 18 });

      const areaText =
        item.areaIntersectM2 == null
          ? "N/A"
          : `${Math.round(item.areaIntersectM2).toLocaleString("en-AU")} m²`;

      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(
          `Overlay code: ${item.code || "N/A"}   •   Intersect area: ${areaText}`,
          x + 14,
          y + 32,
          { width: w - 28, height: 14 }
        );

      // Map container
      const mapY = y + 54;
      const mapH = 170;
      box(doc, x + 14, mapY, w - 28, mapH, {
        fill: BRAND.white,
        stroke: BRAND.border,
        r: 12,
      });

      if (item.mapBuffer) {
        try {
          doc.image(item.mapBuffer, x + 22, mapY + 8, {
            fit: [w - 44, mapH - 16],
          });
        } catch {
          doc
            .fillColor(BRAND.muted)
            .font("Helvetica")
            .fontSize(10)
            .text("Map could not be rendered.", x, mapY + mapH / 2 - 6, {
              width: w,
              align: "center",
            });
        }
      } else {
        doc
          .fillColor(BRAND.muted)
          .font("Helvetica")
          .fontSize(10)
          .text("Map not available for this overlay.", x, mapY + mapH / 2 - 6, {
            width: w,
            align: "center",
          });
      }

      // Narrative / notes
      const noteY = mapY + mapH + 10;
      box(doc, x + 14, noteY, w - 28, 56, {
        fill: BRAND.light,
        stroke: BRAND.border,
        r: 12,
      });

      const text =
        item.narrativeSummary ||
        (item.severity
          ? `Mapped overlay. Notes: ${item.severity}.`
          : "Mapped overlay. Review relevant City Plan codes and mapping legend.");

      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(text, x + 24, noteY + 12, { width: w - 48, height: 40 });
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

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        refs
          .slice(0, 10)
          .map((r) => `• ${r}`)
          .join("\n"),
        x + 14,
        bY + 34,
        { width: w - 28, height: 210 }
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

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(disclaimer, x + 14, dY + 34, { width: w - 28, height: 190 });

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan mapping and applicable codes.",
        x + 14,
        dY + 210,
        { width: w - 28, height: 40 }
      );
  }

  // Footers after all pages exist
  footerAllPages(doc, schemeVersion);

  doc.end();
  return done;
}
