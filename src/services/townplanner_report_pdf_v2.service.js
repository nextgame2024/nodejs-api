// townplanner_report_pdf_v2.service.js
import PDFDocument from "pdfkit";
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

function findOverlayGeometry(planningSnapshot, code) {
  const arr = planningSnapshot?.overlayPolygons;
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((o) => o?.code === code && o?.geometry);
  return hit?.geometry || null;
}

/**
 * Draw helpers (style matches your “great styles” PDF)
 */
const COLORS = {
  header: "#0F2B2B",
  headerText: "#FFFFFF",
  subtleText: "#555555",
  border: "#E6E6E6",
  cellBg: "#F7F7F7",
  label: "#777777",
  value: "#111111",
};

function drawTopBar(doc, leftTitle, rightText) {
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const h = 44;

  doc.save();
  doc.rect(x, y, w, h).fill(COLORS.header);
  doc.fillColor(COLORS.headerText).font("Helvetica-Bold").fontSize(18);
  doc.text(leftTitle, x + 16, y + 13, { width: w - 32, align: "left" });

  doc.fillColor(COLORS.headerText).font("Helvetica").fontSize(10);
  doc.text(rightText || "", x + 16, y + 16, { width: w - 32, align: "right" });

  doc.restore();
  doc.y = y + h + 16;
}

function drawSectionTitle(doc, title) {
  doc.fillColor(COLORS.value).font("Helvetica-Bold").fontSize(20);
  doc.text(title);
  doc.moveDown(0.5);
  doc
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(1);
}

function drawKeyValueGrid(doc, rows) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colW = (w - 12) / 2;
  const rowH = 56;

  let y = doc.y;

  for (let i = 0; i < rows.length; i += 2) {
    const left = rows[i];
    const right = rows[i + 1];

    // left cell
    doc.save();
    doc.rect(x, y, colW, rowH).fill(COLORS.cellBg);
    doc.restore();

    doc.fillColor(COLORS.label).font("Helvetica").fontSize(9);
    doc.text(left.label, x + 12, y + 12, { width: colW - 24 });
    doc.fillColor(COLORS.value).font("Helvetica-Bold").fontSize(12);
    doc.text(left.value, x + 12, y + 28, { width: colW - 24 });

    // right cell
    if (right) {
      const rx = x + colW + 12;

      doc.save();
      doc.rect(rx, y, colW, rowH).fill(COLORS.cellBg);
      doc.restore();

      doc.fillColor(COLORS.label).font("Helvetica").fontSize(9);
      doc.text(right.label, rx + 12, y + 12, { width: colW - 24 });
      doc.fillColor(COLORS.value).font("Helvetica-Bold").fontSize(12);
      doc.text(right.value, rx + 12, y + 28, { width: colW - 24 });
    }

    y += rowH + 10;
  }

  doc.y = y;
}

function drawPlaceholderBox(doc, title, subtitle) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const h = 320;
  const y = doc.y;

  doc.save();
  doc.rect(x, y, w, h).strokeColor(COLORS.border).lineWidth(1).stroke();
  doc.fillColor(COLORS.subtleText).font("Helvetica-Bold").fontSize(12);
  doc.text(title, x, y + 120, { width: w, align: "center" });

  if (subtitle) {
    doc.fillColor(COLORS.subtleText).font("Helvetica").fontSize(10);
    doc.text(subtitle, x + 40, y + 145, { width: w - 80, align: "center" });
  }

  doc.restore();
  doc.y = y + h + 16;
}

function drawMapImage(doc, title, imageBuffer) {
  doc.fillColor(COLORS.value).font("Helvetica-Bold").fontSize(14);
  doc.text(title);
  doc.moveDown(0.6);

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const h = 360;
  const y = doc.y;

  if (!imageBuffer) {
    drawPlaceholderBox(
      doc,
      "Map not available",
      "No geometry/layer available for this section."
    );
    return;
  }

  try {
    doc.image(imageBuffer, x, y, { fit: [w, h] });
    doc.y = y + h + 16;
  } catch {
    drawPlaceholderBox(
      doc,
      "Map could not be rendered",
      "The map image could not be embedded into the PDF."
    );
  }
}

function drawFooter(doc, text) {
  const y = doc.page.height - doc.page.margins.bottom + 10;
  doc.save();
  doc.font("Helvetica").fontSize(8).fillColor(COLORS.subtleText);
  doc.text(text, doc.page.margins.left, y, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    align: "center",
  });
  doc.restore();
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

  const addressLabel =
    pickFirst(
      reportPayload.addressLabel,
      reportPayload.address_label,
      reportPayload?.inputs?.addressLabel,
      reportPayload?.inputs?.address_label
    ) || "Address not provided";

  const lat =
    pickFirst(reportPayload.lat, reportPayload?.inputs?.lat, opts.lat) ?? null;
  const lng =
    pickFirst(reportPayload.lng, reportPayload?.inputs?.lng, opts.lng) ?? null;

  // planningSnapshot can be stored under multiple keys depending on where it came from
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

  // Extract parcel + overlays robustly
  const parcelGeom =
    pickFirst(
      planningSnapshot.siteParcelPolygon,
      planningSnapshot?.propertyParcel?.geometry,
      planningSnapshot?.propertyParcel?.geom,
      reportPayload?.siteParcelPolygon,
      reportPayload?.propertyParcel?.geometry
    ) || null;

  const parcelFeature = featureFromGeometry(parcelGeom);

  const zoningGeom =
    pickFirst(
      planningSnapshot.zoningPolygon,
      planningSnapshot?.zoning?.geometry,
      planningSnapshot?.rawZoningFeature?.geometry
    ) || null;

  const zoningFeature = featureFromGeometry(zoningGeom);

  // Known overlay codes used by planningData_v2.service.js
  const floodOverlandGeom = findOverlayGeometry(
    planningSnapshot,
    "flood_overland"
  );
  const floodRiverGeom = findOverlayGeometry(planningSnapshot, "flood_river");
  const floodCreekGeom = findOverlayGeometry(planningSnapshot, "flood_creek");
  const airportHeightGeom = findOverlayGeometry(
    planningSnapshot,
    "airport_height_restriction"
  );
  const noiseGeom = findOverlayGeometry(
    planningSnapshot,
    "transport_noise_corridor"
  );

  const areaM2 =
    planningSnapshot?.propertyParcel?.debug?.areaM2 ??
    planningSnapshot?.propertyParcel?.debug?.area_m2 ??
    null;

  // Pre-fetch maps (do not let failures break PDF)
  const center =
    lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;

  const parcelMap = parcelFeature
    ? await getParcelMapImageBufferV2({
        apiKey,
        center,
        parcelGeoJson: parcelFeature,
        zoom: 19,
        maptype: "hybrid",
        size: "640x360",
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
          overlayColor: "0x00a3ffff", // blue outline
          overlayFill: "0x00a3ff33", // blue fill
          zoom: 17,
          maptype: "hybrid",
          size: "640x360",
          scale: 2,
        }).catch(() => null)
      : null;

  // Prefer overland > river > creek (for a single flood map page)
  const floodGeom =
    floodOverlandGeom || floodRiverGeom || floodCreekGeom || null;
  const floodFeature = featureFromGeometry(floodGeom);

  const floodMap =
    parcelFeature && floodFeature
      ? await getParcelOverlayMapImageBufferV2({
          apiKey,
          center,
          parcelGeoJson: parcelFeature,
          overlayGeoJson: floodFeature,
          overlayColor: "0xff7f00ff", // orange
          overlayFill: "0xff7f0033",
          zoom: 17,
          maptype: "hybrid",
          size: "640x360",
          scale: 2,
        }).catch(() => null)
      : null;

  const airportFeature = featureFromGeometry(airportHeightGeom);
  const airportMap =
    parcelFeature && airportFeature
      ? await getParcelOverlayMapImageBufferV2({
          apiKey,
          center,
          parcelGeoJson: parcelFeature,
          overlayGeoJson: airportFeature,
          overlayColor: "0xff0000ff", // red
          overlayFill: "0xff000033",
          zoom: 16,
          maptype: "hybrid",
          size: "640x360",
          scale: 2,
        }).catch(() => null)
      : null;

  const noiseFeature = featureFromGeometry(noiseGeom);
  const noiseMap =
    parcelFeature && noiseFeature
      ? await getParcelOverlayMapImageBufferV2({
          apiKey,
          center,
          parcelGeoJson: parcelFeature,
          overlayGeoJson: noiseFeature,
          overlayColor: "0x7b61ffff", // purple
          overlayFill: "0x7b61ff33",
          zoom: 17,
          maptype: "hybrid",
          size: "640x360",
          scale: 2,
        }).catch(() => null)
      : null;

  // Create PDF buffer
  const doc = new PDFDocument({ size: "A4", margin: 56 });
  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const resultPromise = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  //
  // Page 1: Cover / Property Overview
  //
  drawTopBar(doc, "Property Overview", addressLabel);

  drawSectionTitle(doc, "Property snapshot");

  drawKeyValueGrid(doc, [
    { label: "ADDRESS", value: addressLabel },
    { label: "ZONING", value: planningSnapshot.zoning || "Not mapped" },

    {
      label: "NEIGHBOURHOOD PLAN",
      value: planningSnapshot.neighbourhoodPlan || "Not mapped",
    },
    {
      label: "PRECINCT",
      value: planningSnapshot.neighbourhoodPlanPrecinct || "Not mapped",
    },

    { label: "SITE AREA (APPROX.)", value: formatAreaM2(areaM2) },
    { label: "MAXIMUM HEIGHT", value: "N/A" },

    { label: "MINIMUM LOT SIZE", value: "N/A" },
    { label: "MINIMUM FRONTAGE", value: "N/A" },
  ]);

  doc.moveDown(0.6);
  doc.fillColor(COLORS.value).font("Helvetica-Bold").fontSize(18);
  doc.text("Summary", { align: "center" });
  doc.moveDown(0.6);

  doc.fillColor(COLORS.value).font("Helvetica").fontSize(11);
  doc.list(
    [
      `The property is located at ${addressLabel}.`,
      `The property is zoned ${planningSnapshot.zoning || "Not mapped"} under the Brisbane City Plan 2014.`,
      planningSnapshot.neighbourhoodPlan
        ? `Neighbourhood plan: ${planningSnapshot.neighbourhoodPlan}.`
        : `There is no neighbourhood plan affecting the property (based on available mapping).`,
    ],
    { bulletRadius: 2 }
  );

  drawFooter(
    doc,
    "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping."
  );

  //
  // Page 2: Contents
  //
  doc.addPage();
  drawTopBar(doc, "Contents", addressLabel);
  drawSectionTitle(doc, "Report contents");

  const contents = [
    { label: "Property snapshot", page: 1 },
    { label: "Site context (map)", page: 3 },
    { label: "Zoning (map)", page: 4 },
    { label: "Development controls", page: 5 },
    { label: "Flood constraints", page: 6 },
    { label: "Airport environment & height", page: 7 },
    { label: "References & disclaimer", page: 8 },
  ];

  doc.fillColor(COLORS.value).font("Helvetica-Bold").fontSize(11);
  for (const row of contents) {
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width - doc.page.margins.right;

    const y = doc.y;
    doc.text(row.label, leftX, y, { continued: true });

    // dot leaders
    const dotsStart = doc.x + 6;
    const dotsEnd = rightX - 30;
    const dotCount = Math.max(0, Math.floor((dotsEnd - dotsStart) / 4));
    doc.font("Helvetica").fillColor(COLORS.subtleText);
    doc.text(".".repeat(dotCount), dotsStart, y, { continued: true });

    doc.font("Helvetica-Bold").fillColor(COLORS.value);
    doc.text(String(row.page), rightX - 30, y, { width: 30, align: "right" });
    doc.moveDown(0.6);
  }

  doc.moveDown(1);
  doc.fillColor(COLORS.subtleText).font("Helvetica").fontSize(9);
  doc.text(
    "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping."
  );

  drawFooter(doc, "© 2026 sophiaAi");

  //
  // Page 3: Site context (map)
  //
  doc.addPage();
  drawTopBar(doc, "Site context", addressLabel);
  drawSectionTitle(doc, "Site context (map)");
  drawMapImage(doc, "Parcel boundary", parcelMap || null);
  drawFooter(doc, "© 2026 sophiaAi");

  //
  // Page 4: Zoning (map)
  //
  doc.addPage();
  drawTopBar(doc, "Zoning", addressLabel);
  drawSectionTitle(doc, "Zoning (map)");

  if (!zoningFeature) {
    drawPlaceholderBox(
      doc,
      "Zoning map not available",
      "No zoning polygon was returned for this site."
    );
  } else {
    drawMapImage(doc, "Zoning overlay", zoningMap || null);
  }

  drawFooter(doc, "© 2026 sophiaAi");

  //
  // Page 5: Development controls (table-style)
  //
  doc.addPage();
  drawTopBar(doc, "Development controls", addressLabel);
  drawSectionTitle(doc, "Development controls");

  doc.fillColor(COLORS.subtleText).font("Helvetica").fontSize(11);
  doc.text(
    "This section will progressively be populated from City Plan codes (zone / precinct / overlay) and your bcc_planning_controls_v2 lookup."
  );
  doc.moveDown(1);

  drawKeyValueGrid(doc, [
    { label: "MAXIMUM BUILDING HEIGHT", value: "N/A (not mapped yet)" },
    { label: "SITE COVERAGE", value: "N/A (not mapped yet)" },
    { label: "PLOT RATIO / GFA", value: "N/A (not mapped yet)" },
    { label: "MIN LOT SIZE / FRONTAGE", value: "N/A (not mapped yet)" },
  ]);

  drawFooter(doc, "© 2026 sophiaAi");

  //
  // Page 6: Flood constraints (map)
  //
  doc.addPage();
  drawTopBar(doc, "Flood constraints", addressLabel);
  drawSectionTitle(doc, "Flood constraints (map)");

  if (!floodFeature) {
    drawPlaceholderBox(
      doc,
      "No flood overlay found",
      "No flood polygons were returned for this site (overland/river/creek)."
    );
  } else {
    drawMapImage(doc, "Flood overlay", floodMap || null);
  }

  drawFooter(doc, "© 2026 sophiaAi");

  //
  // Page 7: Airport environment & height (map)
  //
  doc.addPage();
  drawTopBar(doc, "Airport environment & height", addressLabel);
  drawSectionTitle(doc, "Airport environment & height (map)");

  if (!airportFeature) {
    drawPlaceholderBox(
      doc,
      "No airport height overlay found",
      "No airport height restriction polygon was returned for this site."
    );
  } else {
    drawMapImage(doc, "Airport height restriction overlay", airportMap || null);
  }

  // Optional noise map (if present) on same page (space permitting)
  if (noiseFeature) {
    drawMapImage(doc, "Transport noise corridor", noiseMap || null);
  }

  drawFooter(doc, "© 2026 sophiaAi");

  //
  // Page 8: References & disclaimer
  //
  doc.addPage();
  drawTopBar(doc, "References & disclaimer", addressLabel);
  drawSectionTitle(doc, "References & disclaimer");

  doc.fillColor(COLORS.value).font("Helvetica-Bold").fontSize(12);
  doc.text("References");
  doc.moveDown(0.5);

  doc.fillColor(COLORS.value).font("Helvetica").fontSize(10);
  doc.list(
    [
      "Brisbane City Plan 2014 (Brisbane City Council).",
      "Brisbane City Plan mapping (Brisbane City Council).",
      "This report is indicative only and is not legal advice.",
      "Always confirm controls and constraints using authoritative sources and engage qualified professionals for development proposals.",
    ],
    { bulletRadius: 2 }
  );

  drawFooter(doc, "© 2026 sophiaAi");

  doc.end();
  return resultPromise;
}
