// townplanner_report_pdf_v2.service.js
import PDFDocument from "pdfkit";
import * as turf from "@turf/turf";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
} from "./googleStaticMaps_v2.service.js";

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
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v;
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

/**
 * The overlay codes produced by planningData_v2.service.js are not the same as the codes
 * previously used by the PDF generator. This alias map makes the PDF robust across code changes.
 */
const OVERLAY_CODE_ALIASES = {
  // Flood
  flood_overland: ["flood_overland_flow", "flood_overland_flow_planning_area"],
  flood_creek: ["flood_creek_waterway"],
  flood_river: ["flood_brisbane_river"],

  // Airport
  airport_height_restriction: ["overlay_airport_height"],
  airport_ols_boundary: ["overlay_airport_ols"],

  // Character / heritage
  dwelling_house_character: ["character_dwelling_house"],
  traditional_building_character: ["character_traditional_building"],
  commercial_character_building: ["character_commercial_building"],
  pre_1911: ["overlay_pre_1911"],
  heritage_state_area: ["overlay_state_heritage_area"],

  // Noise
  transport_noise_corridor: ["transport_noise_corridor"],
};

function findOverlayGeometry(planningSnapshot, code) {
  const arr = planningSnapshot?.overlayPolygons;
  if (!Array.isArray(arr) || !arr.length) return null;

  const codes = [code, ...(OVERLAY_CODE_ALIASES[code] || [])].filter(Boolean);

  for (const c of codes) {
    const hit = arr.find((o) => o?.code === c && o?.geometry);
    if (hit?.geometry) return hit.geometry;
  }

  // fallback: if code already matches something in arr
  const direct = arr.find((o) => o?.code === code && o?.geometry);
  return direct?.geometry || null;
}

function computeIntersectionAreaM2(parcelGeom, overlayGeom) {
  try {
    if (!parcelGeom || !overlayGeom) return null;
    const parcel = featureFromGeometry(parcelGeom);
    const overlay = featureFromGeometry(overlayGeom);
    if (!parcel || !overlay) return null;

    const inter = turf.intersect(parcel, overlay);
    if (!inter) return 0;
    const area = turf.area(inter);
    return Number.isFinite(area) ? area : null;
  } catch {
    return null;
  }
}

/**
 * Styling (sophiaAi look: clean, teal headers, subtle greys, green accent)
 */
const BRAND = {
  teal: "#0F2B2B",
  teal2: "#143838",
  green: "#2ecc71",
  text: "#111111",
  muted: "#555555",
  light: "#F5F7F8",
  border: "#E2E6E9",
  white: "#FFFFFF",
};

const MAP_STYLES_MINIMAL = [
  // Reduced clutter for roadmap overlays
  "feature:poi|visibility:off",
  "feature:transit|visibility:off",
  "feature:road|element:labels.icon|visibility:off",
  "feature:administrative|element:labels|visibility:off",
];

/**
 * Layout helpers
 */
function pageWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function drawRoundedRect(doc, x, y, w, h, r = 10) {
  doc.roundedRect(x, y, w, h, r);
}

function drawHeader(doc, { title, addressLabel, logoBuffer, schemeVersion }) {
  const x = doc.page.margins.left;
  const y = doc.page.margins.top;
  const w = pageWidth(doc);

  // Header band
  doc.save();
  drawRoundedRect(doc, x, y - 10, w, 54, 14);
  doc.fillColor(BRAND.teal).fill();
  doc.restore();

  // Logo
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x + 14, y + 2, { height: 22 });
    } catch {
      // ignore
    }
  } else {
    doc
      .fillColor(BRAND.white)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("sophiaAi", x + 14, y + 6);
  }

  // Title
  doc
    .fillColor(BRAND.white)
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(title || "", x + 160, y + 6, { width: w - 320, align: "center" });

  // Scheme (right)
  doc
    .fillColor(BRAND.white)
    .font("Helvetica")
    .fontSize(9)
    .text(schemeVersion || "", x + 14, y + 28, {
      width: w - 28,
      align: "right",
    });

  // Address line below
  doc
    .fillColor(BRAND.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(addressLabel || "", x, y + 54, { width: w });

  doc.y = y + 78;
}

function drawSectionTitle(doc, title, subtitle = "") {
  const x = doc.page.margins.left;
  const w = pageWidth(doc);

  doc.fillColor(BRAND.text).font("Helvetica-Bold").fontSize(20).text(title, x);
  if (subtitle) {
    doc
      .moveDown(0.2)
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text(subtitle, x, doc.y, { width: w });
  }

  doc.moveDown(0.6);
  doc
    .strokeColor(BRAND.border)
    .lineWidth(1)
    .moveTo(x, doc.y)
    .lineTo(x + w, doc.y)
    .stroke();
  doc.moveDown(1);
}

function drawCard(doc, { x, y, w, h, title, rows }) {
  doc.save();
  drawRoundedRect(doc, x, y, w, h, 14);
  doc.fillColor(BRAND.light).fill();
  doc.restore();

  doc.save();
  drawRoundedRect(doc, x, y, w, h, 14);
  doc.strokeColor(BRAND.border).lineWidth(1).stroke();
  doc.restore();

  if (title) {
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(title, x + 14, y + 12, { width: w - 28 });
  }

  let cy = y + (title ? 30 : 14);
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const label = r?.label || "";
      const value = r?.value || "N/A";

      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(8)
        .text(label, x + 14, cy, { width: w - 28 });

      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(value, x + 14, cy + 12, { width: w - 28 });

      cy += 34;
      if (cy > y + h - 22) break;
    }
  }
}

function drawMapBlock(doc, { title, buffer, x, y, w, h }) {
  // Title
  doc
    .fillColor(BRAND.text)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(title || "", x, y);

  const mapY = y + 18;

  doc.save();
  drawRoundedRect(doc, x, mapY, w, h, 14);
  doc.fillColor(BRAND.light).fill();
  doc.restore();

  doc.save();
  drawRoundedRect(doc, x, mapY, w, h, 14);
  doc.strokeColor(BRAND.border).lineWidth(1).stroke();
  doc.restore();

  if (!buffer) {
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text("Map not available for this section.", x, mapY + h / 2 - 6, {
        width: w,
        align: "center",
      });
    return;
  }

  try {
    doc.image(buffer, x + 10, mapY + 10, { fit: [w - 20, h - 20] });
  } catch {
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text("Map could not be rendered.", x, mapY + h / 2 - 6, {
        width: w,
        align: "center",
      });
  }
}

function stampFooters(doc, { schemeVersion, brandLine }) {
  const range = doc.bufferedPageRange(); // { start, count }
  const total = range.count;

  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);

    const x = doc.page.margins.left;
    const w = pageWidth(doc);
    const y = doc.page.height - doc.page.margins.bottom + 18;

    doc.save();
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(brandLine || "", x, y, { width: w, align: "left" });

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(`Page ${i + 1} of ${total}`, x, y, { width: w, align: "right" });

    if (schemeVersion) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(BRAND.muted)
        .text(schemeVersion, x, y, { width: w, align: "center" });
    }

    doc.restore();
  }
}

function getControlValue(mergedControls, keyCandidates) {
  if (!mergedControls || typeof mergedControls !== "object") return null;
  for (const k of keyCandidates) {
    const v = mergedControls[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

/**
 * Main PDF generator
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

  const mergedControls = controls?.mergedControls || {};

  const narrative =
    safeJsonParse(
      pickFirst(reportPayload.narrative, reportPayload?.inputs?.narrative)
    ) || null;

  // Parcel + zoning
  const parcelGeom =
    pickFirst(
      planningSnapshot.siteParcelPolygon,
      planningSnapshot?.propertyParcel?.geometry
    ) || null;
  const parcelFeature = featureFromGeometry(parcelGeom);

  const zoningGeom =
    pickFirst(
      planningSnapshot.zoningPolygon,
      planningSnapshot?.zoning?.geometry
    ) || null;
  const zoningFeature = featureFromGeometry(zoningGeom);

  const areaM2 =
    planningSnapshot?.propertyParcel?.debug?.areaM2 ??
    planningSnapshot?.propertyParcel?.debug?.area_m2 ??
    null;

  // Center
  const center =
    lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;

  /**
   * Build overlay list for "Potential cautions" from planning.overlays
   */
  const overlays = Array.isArray(planningSnapshot?.overlays)
    ? planningSnapshot.overlays
    : [];

  // Pre-fetch primary maps (do not let failures break PDF)
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
        styles: MAP_STYLES_MINIMAL,
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
          styles: MAP_STYLES_MINIMAL,
          size: "640x420",
          scale: 2,
        }).catch(() => null)
      : null;

  // Build per-overlay map buffers (2 per page later)
  const overlayColorPalette = [
    { outline: "0xff7f00ff", fill: "0xff7f002e" }, // orange
    { outline: "0x7b61ffff", fill: "0x7b61ff2e" }, // purple
    { outline: "0xff0000ff", fill: "0xff00002e" }, // red
    { outline: "0x2ecc71ff", fill: "0x2ecc7126" }, // green
    { outline: "0x0066ffff", fill: "0x0066ff26" }, // blue
  ];

  const overlayItems = [];
  for (let i = 0; i < overlays.length; i += 1) {
    const ov = overlays[i];
    const code = ov?.code || "";
    const name = ov?.name || code || "Overlay";

    // Find matching geometry
    const geom =
      findOverlayGeometry(planningSnapshot, code) ||
      // if code is a known alias-key, try those too
      (Object.prototype.hasOwnProperty.call(OVERLAY_CODE_ALIASES, code)
        ? findOverlayGeometry(planningSnapshot, code)
        : null);

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
            styles: MAP_STYLES_MINIMAL,
            size: "640x360",
            scale: 2,
          }).catch(() => null)
        : null;

    // Narrative snippet (if Gemini generated cautions)
    let narrativeSummary = "";
    if (narrative?.sections) {
      const cautions = narrative.sections.find((s) => s?.id === "cautions");
      const hit = cautions?.items?.find((it) =>
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
      hasGeometry: !!geom,
    });
  }

  /**
   * Decide document structure (Reference-like)
   * - Cover
   * - Contents
   * - Overview
   * - Zoning
   * - Development controls
   * - Potential cautions (2 per page)
   * - References & disclaimer
   */
  const cautionPages = Math.max(1, Math.ceil(overlayItems.length / 2));
  const plan = [
    { id: "cover", title: "Cover", pages: 1 },
    { id: "contents", title: "Contents", pages: 1 },
    { id: "overview", title: "Property overview", pages: 1 },
    { id: "zoning", title: "Zoning", pages: 1 },
    { id: "controls", title: "Development controls", pages: 1 },
    { id: "cautions", title: "Potential cautions", pages: cautionPages },
    { id: "refs", title: "References & disclaimer", pages: 1 },
  ];

  // Compute starting page numbers
  let runningPage = 1;
  const toc = [];
  for (const s of plan) {
    toc.push({ label: s.title, page: runningPage });
    runningPage += s.pages;
  }

  // Create PDF buffer
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    bufferPages: true,
  });
  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const resultPromise = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  /**
   * PAGE 1: Cover
   */
  // full-bleed feel using background blocks
  {
    const x0 = doc.page.margins.left;
    const w = pageWidth(doc);

    // Big teal header area
    doc.save();
    drawRoundedRect(doc, x0, 56, w, 170, 20);
    doc.fillColor(BRAND.teal).fill();
    doc.restore();

    // Logo + title
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, x0 + 20, 80, { height: 28 });
      } catch {
        // ignore
      }
    } else {
      doc
        .fillColor(BRAND.white)
        .font("Helvetica-Bold")
        .fontSize(22)
        .text("sophiaAi", x0 + 20, 78);
    }

    doc
      .fillColor(BRAND.white)
      .font("Helvetica-Bold")
      .fontSize(24)
      .text("Property Planning Report", x0 + 20, 122, { width: w - 40 });

    doc
      .fillColor(BRAND.white)
      .font("Helvetica")
      .fontSize(11)
      .text(`${addressLabel}`, x0 + 20, 154, { width: w - 40 });

    doc
      .fillColor(BRAND.white)
      .font("Helvetica")
      .fontSize(10)
      .text(
        `Generated ${formatDateAU(generatedAt)} • ${schemeVersion}`,
        x0 + 20,
        176,
        { width: w - 40 }
      );

    // Map hero (muted) below
    const mapX = x0;
    const mapY = 250;
    const mapW = w;
    const mapH = 320;

    if (siteContextMap) {
      doc.save();
      drawRoundedRect(doc, mapX, mapY, mapW, mapH, 20);
      doc.clip();
      try {
        doc
          .opacity(0.95)
          .image(siteContextMap, mapX, mapY, { fit: [mapW, mapH] });
      } catch {
        // ignore
      }
      doc.restore();
    } else {
      drawMapBlock(doc, {
        title: "",
        buffer: null,
        x: mapX,
        y: mapY - 18,
        w: mapW,
        h: mapH,
      });
    }

    // small info block
    doc.save();
    drawRoundedRect(doc, x0, 590, w, 110, 16);
    doc.fillColor(BRAND.light).fill();
    doc.restore();

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("Report inputs", x0 + 18, 606);

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        `Place ID: ${placeId || "N/A"}\nCoordinates: ${formatCoords(lat, lng)}`,
        x0 + 18,
        626,
        { width: w - 36 }
      );
  }

  /**
   * PAGE 2: Contents
   */
  doc.addPage();
  drawHeader(doc, {
    title: "Contents",
    addressLabel,
    logoBuffer,
    schemeVersion,
  });
  drawSectionTitle(doc, "Report contents", "Sections included in this report.");

  {
    const x = doc.page.margins.left;
    const rightX = doc.page.width - doc.page.margins.right;

    doc.fillColor(BRAND.text).font("Helvetica-Bold").fontSize(11);

    for (const row of toc) {
      const y = doc.y;
      doc.text(row.label, x, y, { continued: true });

      // dot leaders
      const dotsStart = doc.x + 6;
      const dotsEnd = rightX - 34;
      const dotCount = Math.max(0, Math.floor((dotsEnd - dotsStart) / 3.5));

      doc.font("Helvetica").fillColor(BRAND.muted);
      doc.text(".".repeat(dotCount), dotsStart, y, { continued: true });

      doc.font("Helvetica-Bold").fillColor(BRAND.text);
      doc.text(String(row.page), rightX - 34, y, { width: 34, align: "right" });

      doc.moveDown(0.6);
    }

    doc.moveDown(1);
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        "Maps are indicative only. For authoritative mapping and controls, verify against Brisbane City Plan mapping and applicable codes."
      );
  }

  /**
   * PAGE 3: Property overview
   */
  doc.addPage();
  drawHeader(doc, {
    title: "Property overview",
    addressLabel,
    logoBuffer,
    schemeVersion,
  });
  drawSectionTitle(doc, "Property snapshot");

  {
    const x = doc.page.margins.left;
    const w = pageWidth(doc);

    // Hero map
    drawMapBlock(doc, {
      title: "Site context map",
      buffer: siteContextMap,
      x,
      y: doc.y,
      w,
      h: 260,
    });

    doc.y += 300;

    // Cards row (2)
    const gap = 12;
    const cardW = (w - gap) / 2;

    const zoningText = planningSnapshot?.zoning || "Not mapped";
    const npText = planningSnapshot?.neighbourhoodPlan || "Not mapped";
    const precinctText =
      planningSnapshot?.neighbourhoodPlanPrecinct || "Not mapped";

    drawCard(doc, {
      x,
      y: doc.y,
      w: cardW,
      h: 170,
      title: "Property details",
      rows: [
        { label: "ADDRESS", value: addressLabel },
        { label: "SITE AREA (APPROX.)", value: formatAreaM2(areaM2) },
        { label: "COORDINATES", value: formatCoords(lat, lng) },
      ],
    });

    drawCard(doc, {
      x: x + cardW + gap,
      y: doc.y,
      w: cardW,
      h: 170,
      title: "Planning context",
      rows: [
        { label: "ZONING", value: zoningText },
        { label: "NEIGHBOURHOOD PLAN", value: npText },
        { label: "PRECINCT", value: precinctText },
      ],
    });

    doc.y += 190;

    // Potential cautions list (from overlays)
    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("Potential cautions", x, doc.y);

    doc.moveDown(0.3);
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);

    if (!overlayItems.length) {
      doc.text(
        "No overlays were returned for this site based on current inputs."
      );
    } else {
      const bullets = overlayItems.slice(0, 10).map((o) => o.name);
      doc.list(bullets, { bulletRadius: 2 });
      if (overlayItems.length > 10) {
        doc.text(
          `…and ${overlayItems.length - 10} more (see “Potential cautions”).`
        );
      }
    }
  }

  /**
   * PAGE 4: Zoning
   */
  doc.addPage();
  drawHeader(doc, {
    title: "Zoning",
    addressLabel,
    logoBuffer,
    schemeVersion,
  });
  drawSectionTitle(doc, "Zoning (map)");

  {
    const x = doc.page.margins.left;
    const w = pageWidth(doc);

    drawMapBlock(doc, {
      title: "Zoning overlay",
      buffer: zoningMap,
      x,
      y: doc.y,
      w,
      h: 320,
    });

    doc.y += 360;

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text(
        `Mapped zoning: ${planningSnapshot?.zoning || "Not mapped"}.\nConfirm boundaries and zone intent against Brisbane City Plan mapping and applicable codes.`
      );
  }

  /**
   * PAGE 5: Development controls
   */
  doc.addPage();
  drawHeader(doc, {
    title: "Development controls",
    addressLabel,
    logoBuffer,
    schemeVersion,
  });
  drawSectionTitle(
    doc,
    "Key development controls",
    "Where available from the controls database."
  );

  {
    const x = doc.page.margins.left;
    const w = pageWidth(doc);
    const gap = 12;
    const cardW = (w - gap) / 2;

    // Try to populate from mergedControls, but remain conservative if missing.
    // Adapt keys to your actual control schema as you populate bcc_planning_controls_v2.
    const maxHeight =
      getControlValue(mergedControls, [
        "maximumHeight",
        "maxHeight",
        "max_building_height",
      ]) || "Not available from provided controls";

    const minLot =
      getControlValue(mergedControls, [
        "minimumLotSize",
        "minLotSize",
        "min_lot_size",
      ]) || "Not available from provided controls";

    const minFrontage =
      getControlValue(mergedControls, [
        "minimumFrontage",
        "minFrontage",
        "min_frontage",
      ]) || "Not available from provided controls";

    const siteCoverage =
      getControlValue(mergedControls, [
        "maximumSiteCoverage",
        "siteCoverage",
        "max_site_coverage",
      ]) || "Not available from provided controls";

    const plotRatio =
      getControlValue(mergedControls, [
        "plotRatio",
        "maxPlotRatio",
        "gfaRatio",
        "max_plot_ratio",
      ]) || "Not available from provided controls";

    const density =
      getControlValue(mergedControls, [
        "density",
        "maxDensity",
        "max_density",
      ]) || "Not available from provided controls";

    drawCard(doc, {
      x,
      y: doc.y,
      w: cardW,
      h: 210,
      title: "Lot & built form",
      rows: [
        { label: "MAXIMUM BUILDING HEIGHT", value: String(maxHeight) },
        { label: "MAXIMUM SITE COVERAGE", value: String(siteCoverage) },
        { label: "PLOT RATIO / GFA", value: String(plotRatio) },
        { label: "DENSITY (IF APPLICABLE)", value: String(density) },
      ],
    });

    drawCard(doc, {
      x: x + cardW + gap,
      y: doc.y,
      w: cardW,
      h: 210,
      title: "Subdivision & dimensions",
      rows: [
        { label: "MINIMUM LOT SIZE", value: String(minLot) },
        { label: "MINIMUM FRONTAGE", value: String(minFrontage) },
        { label: "SITE AREA (APPROX.)", value: formatAreaM2(areaM2) },
      ],
    });

    doc.y += 230;

    // Narrative notes (if present)
    const devSection = narrative?.sections?.find(
      (s) => s?.id === "development"
    );
    const bullets = Array.isArray(devSection?.bullets)
      ? devSection.bullets
      : [];

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("Development potential notes", x, doc.y);

    doc.moveDown(0.3);
    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);

    if (bullets.length) {
      doc.list(bullets.slice(0, 8), { bulletRadius: 2 });
    } else {
      doc.text(
        "This section will expand as additional City Plan code controls are curated into bcc_planning_controls_v2."
      );
    }
  }

  /**
   * Potential cautions pages (2 per page)
   */
  for (let p = 0; p < cautionPages; p += 1) {
    doc.addPage();
    drawHeader(doc, {
      title: "Potential cautions",
      addressLabel,
      logoBuffer,
      schemeVersion,
    });
    drawSectionTitle(
      doc,
      "Potential cautions",
      "Overlays and constraints returned by current spatial inputs. Verify against authoritative mapping."
    );

    const x = doc.page.margins.left;
    const w = pageWidth(doc);

    const top = overlayItems[p * 2] || null;
    const bottom = overlayItems[p * 2 + 1] || null;

    const blockH = 250;

    const drawOverlayBlock = (item, y) => {
      if (!item) return;

      // Title line
      doc
        .fillColor(BRAND.text)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(item.name, x, y);

      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(
          `Overlay code: ${item.code || "N/A"}   •   Intersect area: ${
            item.areaIntersectM2 == null
              ? "N/A"
              : `${Math.round(item.areaIntersectM2).toLocaleString("en-AU")} m²`
          }`,
          x,
          y + 16,
          { width: w }
        );

      // Map + narrative card
      const mapY = y + 36;
      const mapW = w;
      const mapH = 150;

      drawMapBlock(doc, {
        title: "Overlay map (parcel + overlay highlight)",
        buffer: item.mapBuffer,
        x,
        y: mapY,
        w: mapW,
        h: mapH,
      });

      const noteY = mapY + mapH + 26;

      doc.save();
      drawRoundedRect(doc, x, noteY, w, 50, 14);
      doc.fillColor(BRAND.light).fill();
      doc.restore();

      doc.save();
      drawRoundedRect(doc, x, noteY, w, 50, 14);
      doc.strokeColor(BRAND.border).lineWidth(1).stroke();
      doc.restore();

      const text =
        item.narrativeSummary ||
        (item.severity
          ? `Mapped overlay. Notes: ${item.severity}.`
          : "Mapped overlay. Review relevant City Plan codes and mapping legend.");

      doc
        .fillColor(BRAND.muted)
        .font("Helvetica")
        .fontSize(9)
        .text(text, x + 14, noteY + 14, { width: w - 28, height: 40 });
    };

    const y0 = doc.y;
    drawOverlayBlock(top, y0);
    drawOverlayBlock(bottom, y0 + blockH + 70);
  }

  /**
   * References & disclaimer
   */
  doc.addPage();
  drawHeader(doc, {
    title: "References & disclaimer",
    addressLabel,
    logoBuffer,
    schemeVersion,
  });
  drawSectionTitle(doc, "References & disclaimer");

  {
    const x = doc.page.margins.left;
    const w = pageWidth(doc);

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("References");
    doc.moveDown(0.4);

    const refsFromNarrative =
      narrative?.sections?.find((s) => s?.id === "references")?.items || [];

    const refs = [
      "Brisbane City Plan 2014 (Brisbane City Council).",
      "Brisbane City Plan mapping (Brisbane City Council).",
      ...refsFromNarrative.map((r) => String(r)),
    ].filter(Boolean);

    doc.fillColor(BRAND.muted).font("Helvetica").fontSize(10);
    doc.list(refs.slice(0, 10), { bulletRadius: 2 });

    doc.moveDown(1);

    doc
      .fillColor(BRAND.text)
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("Disclaimer");
    doc.moveDown(0.4);

    const disclaimer =
      narrative?.disclaimer ||
      "This report is based solely on the provided factual inputs and Brisbane City Plan mapping. It does not constitute professional planning advice. Verify requirements against authoritative sources and obtain professional advice for specific development proposals.";

    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(10)
      .text(disclaimer, x, doc.y, {
        width: w,
      });

    doc.moveDown(1);
    doc
      .fillColor(BRAND.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(
        "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan mapping and applicable codes.",
        x,
        doc.y,
        { width: w }
      );
  }

  // Stamp footers/page numbers after all pages exist (prevents "Page undefined")
  stampFooters(doc, {
    schemeVersion,
    brandLine: "Brisbane Town Planner • sophiaAi",
  });

  doc.end();
  return resultPromise;
}
