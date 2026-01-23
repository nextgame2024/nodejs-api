import PDFDocument from "pdfkit";

import {
  staticMapParcelOnly,
  staticMapParcelWithOverlay,
} from "./googleStaticMaps_v2.service.js";

/**
 * Town Planner V2 — “reference-style” PDF generator
 *
 * This file intentionally does not depend on Puppeteer/HTML rendering.
 * It uses PDFKit with defensive fallbacks so maps/tables never render blank.
 *
 * Key behaviours:
 * - Always renders a Contents page + structured Snapshot tables.
 * - Each section renders either:
 *    - a map image, OR
 *    - a clear “Map not available” placeholder panel.
 * - If a layer is not mapped for the address, the section still exists with “Not mapped”.
 */

const PAGE_SIZE = "A4";
const MARGIN = 48;

const COLORS = {
  brand: "#0B3B34",
  brand2: "#0E4A42",
  text: "#111827",
  muted: "#6B7280",
  border: "#E5E7EB",
  lightFill: "#F9FAFB",
  rowAlt: "#F3F4F6",
  warnFill: "#FFF7ED",
  warnText: "#9A3412",
};

function safeText(v, fallback = "N/A") {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function formatM2(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "N/A";
  // integer m² looks best in the report
  return `${Math.round(n).toLocaleString()} m²`;
}

function pickPlanningOverlay(planning, codes = []) {
  const arr = Array.isArray(planning?.overlayPolygons)
    ? planning.overlayPolygons
    : [];
  return arr.find((o) => codes.includes(o?.code)) || null;
}

function asGeoJSONFromOverlay(overlay) {
  const g = overlay?.geometry;
  if (!g) return null;
  // Planning service stores geometry as a GeoJSON geometry object (Polygon/MultiPolygon)
  if (g?.type && (g.type === "Polygon" || g.type === "MultiPolygon")) {
    return { type: "Feature", geometry: g, properties: {} };
  }
  // If already a Feature:
  if (g?.type === "Feature") return g;
  return null;
}

function asFeatureFromGeometry(geom) {
  if (!geom) return null;
  if (geom?.type === "Feature") return geom;
  if (geom?.type && (geom.type === "Polygon" || geom.type === "MultiPolygon")) {
    return { type: "Feature", geometry: geom, properties: {} };
  }
  return null;
}

/**
 * A simple “header bar” consistent across pages:
 * Left: page title, Right: address label
 */
function drawHeaderBar(doc, title, addressLabel) {
  const pageWidth = doc.page.width;
  const barH = 42;

  doc.save();
  doc.rect(0, 0, pageWidth, barH).fill(COLORS.brand);

  doc
    .fillColor("white")
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(title, MARGIN, 13, { width: pageWidth - MARGIN * 2 - 220 });

  doc
    .fillColor("white")
    .font("Helvetica")
    .fontSize(9)
    .text(safeText(addressLabel, ""), pageWidth - MARGIN - 220, 14, {
      width: 220,
      align: "right",
      ellipsis: true,
    });

  doc.restore();
  doc.y = barH + 18;
}

function drawFooter(doc, pageNo) {
  const pageWidth = doc.page.width;
  const y = doc.page.height - 24;

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(`Page ${pageNo}`, MARGIN, y, {
      width: pageWidth - MARGIN * 2,
      align: "right",
    });
}

function sectionTitle(doc, text) {
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(COLORS.text)
    .text(text, MARGIN, doc.y, { width: doc.page.width - MARGIN * 2 });
  doc.moveDown(0.6);
  doc
    .strokeColor(COLORS.border)
    .lineWidth(1)
    .moveTo(MARGIN, doc.y)
    .lineTo(doc.page.width - MARGIN, doc.y)
    .stroke();
  doc.moveDown(1.1);
}

/**
 * Two-column “snapshot” cards, like your reference PDF.
 * Input rows: [{ label, value }]
 */
function keyValueGrid(doc, rows, { columns = 2 } = {}) {
  const pageWidth = doc.page.width;
  const usableW = pageWidth - MARGIN * 2;
  const colGap = 14;
  const colW = (usableW - colGap * (columns - 1)) / columns;

  const rowH = 60;
  const labelYOff = 12;
  const valueYOff = 30;

  rows.forEach((r, idx) => {
    const rowIndex = Math.floor(idx / columns);
    const colIndex = idx % columns;

    const x = MARGIN + colIndex * (colW + colGap);
    const y = doc.y + rowIndex * rowH;

    doc.save();
    doc
      .rect(x, y, colW, rowH - 10)
      .fill(COLORS.rowAlt)
      .restore();

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(String(r.label || "").toUpperCase(), x + 12, y + labelYOff, {
        width: colW - 24,
      });

    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(COLORS.text)
      .text(safeText(r.value), x + 12, y + valueYOff, { width: colW - 24 });

    // border
    doc
      .strokeColor(COLORS.border)
      .lineWidth(1)
      .rect(x, y, colW, rowH - 10)
      .stroke();
  });

  const totalRows = Math.ceil(rows.length / columns);
  doc.y = doc.y + totalRows * rowH;
  doc.moveDown(0.6);
}

/**
 * A table with two columns, light stripes, good readability.
 */
function twoColTable(doc, items, { col1 = "Item", col2 = "Value" } = {}) {
  const w = doc.page.width - MARGIN * 2;
  const x = MARGIN;
  const y0 = doc.y;

  const headerH = 26;
  const rowH = 26;

  const col1W = Math.floor(w * 0.55);
  const col2W = w - col1W;

  // header
  doc.save();
  doc.rect(x, y0, w, headerH).fill(COLORS.brand2);
  doc
    .fillColor("white")
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(col1, x + 10, y0 + 8, { width: col1W - 20 })
    .text(col2, x + col1W + 10, y0 + 8, { width: col2W - 20 });
  doc.restore();

  // body
  let y = y0 + headerH;
  items.forEach((it, idx) => {
    const fill = idx % 2 === 0 ? COLORS.lightFill : "white";
    doc.save();
    doc.rect(x, y, w, rowH).fill(fill);
    doc.restore();

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(COLORS.text)
      .text(safeText(it.label), x + 10, y + 7, { width: col1W - 20 })
      .text(safeText(it.value), x + col1W + 10, y + 7, { width: col2W - 20 });

    doc.strokeColor(COLORS.border).lineWidth(1).rect(x, y, w, rowH).stroke();

    y += rowH;
  });

  doc.y = y + 10;
}

function placeholderPanel(doc, title, message) {
  const w = doc.page.width - MARGIN * 2;
  const x = MARGIN;
  const y = doc.y;

  doc.save();
  doc.rect(x, y, w, 260).fill(COLORS.warnFill).stroke(COLORS.border);
  doc.restore();

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(COLORS.warnText)
    .text(title, x + 16, y + 18, { width: w - 32 });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(COLORS.warnText)
    .text(message, x + 16, y + 44, { width: w - 32 });

  doc.y = y + 280;
}

/**
 * Attempts to generate a static map image buffer. On failure returns null.
 * Caller should draw placeholder instead of leaving a blank page.
 */
async function safeGetMapBuffer(fn) {
  try {
    const buf = await fn();
    if (!buf || !Buffer.isBuffer(buf) || buf.length < 128) return null;
    return buf;
  } catch (e) {
    return null;
  }
}

function drawMapImage(doc, buf, { height = 360 } = {}) {
  if (!buf) return false;
  const w = doc.page.width - MARGIN * 2;
  const x = MARGIN;
  const y = doc.y;

  doc.strokeColor(COLORS.border).lineWidth(1).rect(x, y, w, height).stroke();

  // Fit inside border with small padding
  doc.image(buf, x + 1, y + 1, { fit: [w - 2, height - 2] });
  doc.y = y + height + 16;
  return true;
}

/**
 * Build the report PDF and return a Buffer.
 *
 * @param {object} payload
 * @param {object} payload.request      report request record (token, address_label, ... optional)
 * @param {object} payload.planning     planning snapshot from planningData_v2.service
 * @param {object} payload.narrative    gemini result (optional)
 */
export async function buildTownPlannerReportPdfV2({
  request,
  planning,
  narrative,
}) {
  const addressLabel =
    request?.address_label || planning?.address_label || request?.addressLabel;

  const doc = new PDFDocument({
    size: PAGE_SIZE,
    margin: MARGIN,
    autoFirstPage: true,
  });

  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  // Page numbering: keep stable like the reference PDF.
  // 1 Cover, 2 Contents, 3 Snapshot, 4 Zoning (map), 5 Development controls,
  // 6 Flood constraints, 7 Airport environment & height, 8 References & disclaimer
  let pageNo = 1;

  function newPage() {
    drawFooter(doc, pageNo);
    doc.addPage();
    pageNo += 1;
  }

  // ---- Helpers for geometry ----
  const parcelFeature = asFeatureFromGeometry(planning?.siteParcelPolygon);
  const zoningFeature = asFeatureFromGeometry(planning?.zoningPolygon);

  const floodOverlay = pickPlanningOverlay(planning, [
    "FLOOD_OVERLAND",
    "FLOOD_RIVER",
    "FLOOD_CREEK",
    "FLOODING",
  ]);
  const floodFeature = asGeoJSONFromOverlay(floodOverlay);

  const airportOverlay = pickPlanningOverlay(planning, [
    "AIRPORT_ENVIRONMENT",
    "AIRPORT_HEIGHT_RESTRICTION",
    "AIRPORT_ENV_HEIGHT",
  ]);
  const airportFeature = asGeoJSONFromOverlay(airportOverlay);

  // ---- Cover page ----
  drawHeaderBar(doc, "Property Planning Report", addressLabel);
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(COLORS.muted)
    .text(
      "Indicative planning overview generated from City Plan mapping layers.",
      MARGIN,
      doc.y
    );

  doc.moveDown(1.1);

  // Cover hero map (parcel-only, hybrid)
  const coverMap = await safeGetMapBuffer(() =>
    staticMapParcelOnly({
      parcelGeoJSON: parcelFeature,
      maptype: "hybrid",
      size: "640x360",
      scale: 2,
    })
  );

  if (!drawMapImage(doc, coverMap, { height: 360 })) {
    placeholderPanel(
      doc,
      "Map not available",
      "We could not render a map for this address. This usually means the parcel boundary was not found in our dataset yet, or the Static Maps request failed."
    );
  }

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(
      "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping.",
      MARGIN,
      doc.y,
      { width: doc.page.width - MARGIN * 2 }
    );

  // ---- Contents page ----
  newPage();
  drawHeaderBar(doc, "Contents", addressLabel);
  sectionTitle(doc, "Report contents");

  const contentsItems = [
    { label: "Property snapshot", page: 3 },
    { label: "Zoning (map)", page: 4 },
    { label: "Development controls", page: 5 },
    { label: "Flood constraints", page: 6 },
    { label: "Airport environment & height", page: 7 },
    { label: "References & disclaimer", page: 8 },
  ];

  doc.font("Helvetica").fontSize(11).fillColor(COLORS.text);

  // dotted leader
  const leftX = MARGIN;
  const rightX = doc.page.width - MARGIN;

  contentsItems.forEach((it) => {
    const y = doc.y;
    doc.text(it.label, leftX, y, { continued: true });

    // draw dots between label and page number
    const labelW = doc.widthOfString(it.label) + 8;
    const pageStr = String(it.page);
    const pageW = doc.widthOfString(pageStr) + 2;

    const dotsStart = leftX + labelW;
    const dotsEnd = rightX - pageW - 6;

    const dotsCount = Math.max(0, Math.floor((dotsEnd - dotsStart) / 4));
    const dots = ".".repeat(dotsCount);

    doc.fillColor(COLORS.muted).text(dots, dotsStart, y, { continued: true });

    doc.fillColor(COLORS.text).text(pageStr, rightX - pageW, y);

    doc.moveDown(0.6);
  });

  doc.moveDown(1.0);

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(
      "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping.",
      MARGIN,
      doc.y,
      { width: doc.page.width - MARGIN * 2 }
    );

  // ---- Property snapshot page ----
  newPage();
  drawHeaderBar(doc, "Property Overview", addressLabel);
  sectionTitle(doc, "Property snapshot");

  const snapshotRows = [
    { label: "Address", value: safeText(addressLabel) },
    {
      label: "Zoning",
      value: safeText(planning?.zoning?.name || planning?.zoning?.zone_name),
    },
    {
      label: "Neighbourhood plan",
      value: safeText(planning?.neighbourhoodPlan?.name || "Not mapped"),
    },
    {
      label: "Precinct",
      value: safeText(planning?.precinct?.name || "Not mapped"),
    },
    { label: "Site area (approx.)", value: formatM2(planning?.siteAreaM2) },
    {
      label: "Maximum height",
      value: safeText(
        planning?.controls?.maximumHeight ||
          planning?.controls?.maxHeight ||
          "N/A"
      ),
    },
    {
      label: "Minimum lot size",
      value: safeText(
        planning?.controls?.minimumLotSize ||
          planning?.controls?.minLotSize ||
          "N/A"
      ),
    },
    {
      label: "Minimum frontage",
      value: safeText(
        planning?.controls?.minimumFrontage ||
          planning?.controls?.minFrontage ||
          "N/A"
      ),
    },
  ];

  keyValueGrid(doc, snapshotRows, { columns: 2 });

  doc.moveDown(0.6);
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(COLORS.text)
    .text("Summary", MARGIN, doc.y, { align: "center" });

  doc.moveDown(0.6);

  const summaryLines = [];

  // Prefer Gemini narrative if available, otherwise derive basic summary
  if (
    Array.isArray(narrative?.executiveSummary) &&
    narrative.executiveSummary.length
  ) {
    narrative.executiveSummary.forEach((s) => summaryLines.push(String(s)));
  } else {
    summaryLines.push(`The property is located at ${safeText(addressLabel)}.`);
    if (planning?.zoning?.name || planning?.zoning?.zone_name) {
      summaryLines.push(
        `The property is zoned ${safeText(planning?.zoning?.name || planning?.zoning?.zone_name)} under the Brisbane City Plan 2014.`
      );
    }
    if (!planning?.neighbourhoodPlan?.name) {
      summaryLines.push(
        "There is no neighbourhood plan affecting the property (not mapped)."
      );
    } else {
      summaryLines.push(
        `Neighbourhood plan: ${safeText(planning.neighbourhoodPlan.name)}.`
      );
    }
  }

  doc.font("Helvetica").fontSize(11).fillColor(COLORS.text);

  // bullets centered like your reference screenshot
  const bulletIndent = 18;
  const textWidth = doc.page.width - MARGIN * 2 - 140;
  const xCenter = (doc.page.width - textWidth) / 2;

  summaryLines.forEach((line) => {
    doc.text(`• ${line}`, xCenter, doc.y, { width: textWidth, indent: 0 });
    doc.moveDown(0.35);
  });

  // ---- Zoning (map) page ----
  newPage();
  drawHeaderBar(doc, "Zoning", addressLabel);
  sectionTitle(doc, "Zoning (map)");

  const zoningMap = await safeGetMapBuffer(() =>
    staticMapParcelWithOverlay({
      parcelGeoJSON: parcelFeature,
      overlayGeoJSON: zoningFeature || null,
      maptype: "hybrid",
      size: "640x360",
      scale: 2,
      overlayStyle: "zoning",
    })
  );

  if (!drawMapImage(doc, zoningMap, { height: 360 })) {
    placeholderPanel(
      doc,
      "Zoning map not available",
      "We could not render the zoning map for this address. This usually means the parcel boundary or zoning polygon was not found."
    );
  }

  twoColTable(
    doc,
    [
      {
        label: "Zone",
        value: safeText(planning?.zoning?.name || planning?.zoning?.zone_name),
      },
      {
        label: "Zone code",
        value: safeText(planning?.zoning?.code || planning?.zoning?.zone_code),
      },
      {
        label: "Neighbourhood plan",
        value: safeText(planning?.neighbourhoodPlan?.name || "Not mapped"),
      },
      {
        label: "Precinct",
        value: safeText(planning?.precinct?.name || "Not mapped"),
      },
    ],
    { col1: "Zoning attributes", col2: "Value" }
  );

  // ---- Development controls page ----
  newPage();
  drawHeaderBar(doc, "Development controls", addressLabel);
  sectionTitle(doc, "Development controls");

  const controls = planning?.controls || {};
  const controlRows = [
    {
      label: "Maximum building height",
      value: safeText(controls.maximumHeight || controls.maxHeight || "N/A"),
    },
    {
      label: "Minimum lot size",
      value: safeText(controls.minimumLotSize || controls.minLotSize || "N/A"),
    },
    {
      label: "Minimum frontage",
      value: safeText(
        controls.minimumFrontage || controls.minFrontage || "N/A"
      ),
    },
    {
      label: "Plot ratio / GFA",
      value: safeText(controls.plotRatio || controls.gfa || "N/A"),
    },
    { label: "Site coverage", value: safeText(controls.siteCoverage || "N/A") },
    {
      label: "Density / dwellings",
      value: safeText(controls.density || controls.dwellings || "N/A"),
    },
  ];

  twoColTable(doc, controlRows, { col1: "Control", col2: "Requirement" });

  if (
    Array.isArray(narrative?.developmentControls) &&
    narrative.developmentControls.length
  ) {
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(COLORS.text)
      .text("Notes", MARGIN, doc.y);
    doc.moveDown(0.4);

    doc.font("Helvetica").fontSize(10).fillColor(COLORS.text);
    narrative.developmentControls.slice(0, 8).forEach((t) => {
      doc.text(`• ${String(t)}`, MARGIN + 12, doc.y, {
        width: doc.page.width - MARGIN * 2 - 12,
      });
      doc.moveDown(0.25);
    });
  }

  // ---- Flood constraints page ----
  newPage();
  drawHeaderBar(doc, "Flood constraints", addressLabel);
  sectionTitle(doc, "Flood constraints");

  const floodMap = await safeGetMapBuffer(() =>
    staticMapParcelWithOverlay({
      parcelGeoJSON: parcelFeature,
      overlayGeoJSON: floodFeature || null,
      maptype: "hybrid",
      size: "640x360",
      scale: 2,
      overlayStyle: "flood",
    })
  );

  if (!drawMapImage(doc, floodMap, { height: 360 })) {
    placeholderPanel(
      doc,
      "Flood map not available",
      "We could not render the flood constraints map for this address. This usually means the parcel boundary was not found, or the map request failed."
    );
  }

  twoColTable(
    doc,
    [
      {
        label: "Flood overlay mapped",
        value: floodOverlay
          ? safeText(floodOverlay?.name || floodOverlay?.code)
          : "Not mapped",
      },
      {
        label: "Notes",
        value: floodOverlay
          ? "Overlay intersects the subject site (indicative)."
          : "No flood overlay polygon was found intersecting the subject site.",
      },
    ],
    { col1: "Flood constraints", col2: "Detail" }
  );

  // ---- Airport environment & height page ----
  newPage();
  drawHeaderBar(doc, "Airport environment & height", addressLabel);
  sectionTitle(doc, "Airport environment & height");

  const airportMap = await safeGetMapBuffer(() =>
    staticMapParcelWithOverlay({
      parcelGeoJSON: parcelFeature,
      overlayGeoJSON: airportFeature || null,
      maptype: "hybrid",
      size: "640x360",
      scale: 2,
      overlayStyle: "airport",
    })
  );

  if (!drawMapImage(doc, airportMap, { height: 360 })) {
    placeholderPanel(
      doc,
      "Airport overlay map not available",
      "We could not render the airport overlay map for this address. This may mean the parcel boundary was not found, or the airport overlay is not mapped for this location."
    );
  }

  twoColTable(
    doc,
    [
      {
        label: "Airport overlay mapped",
        value: airportOverlay
          ? safeText(airportOverlay?.name || airportOverlay?.code)
          : "Not mapped",
      },
      {
        label: "Height restriction",
        value: safeText(controls.maximumHeight || controls.maxHeight || "N/A"),
      },
    ],
    { col1: "Airport environments", col2: "Detail" }
  );

  // ---- References & disclaimer ----
  newPage();
  drawHeaderBar(doc, "References & disclaimer", addressLabel);
  sectionTitle(doc, "References & disclaimer");

  const refs = [
    "Brisbane City Plan 2014 (Brisbane City Council).",
    "City Plan mapping layers (indicative).",
    "This report is provided for information only and does not constitute planning advice.",
    "Always confirm requirements with Brisbane City Council and the relevant planning codes.",
  ];

  doc.font("Helvetica").fontSize(11).fillColor(COLORS.text);
  refs.forEach((r) => {
    doc.text(`• ${r}`, MARGIN, doc.y, { width: doc.page.width - MARGIN * 2 });
    doc.moveDown(0.35);
  });

  doc.moveDown(1.0);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(
      "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping.",
      MARGIN,
      doc.y,
      { width: doc.page.width - MARGIN * 2 }
    );

  // finalize last footer
  drawFooter(doc, pageNo);

  doc.end();

  await new Promise((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  return Buffer.concat(chunks);
}
