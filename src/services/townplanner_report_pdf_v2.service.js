import PDFDocument from "pdfkit";
import { PassThrough } from "stream";

import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
} from "./googleStaticMaps_v2.service.js";

/**
 * Build the v2 Town Planner PDF.
 * This function is called by townplanner_report_v2.service.js with:
 * { schemeVersion, addressLabel, placeId, lat, lng, planning, controls, narrative, logoBuffer }
 */
export async function buildTownPlannerReportPdfV2({
  schemeVersion,
  addressLabel,
  placeId,
  lat,
  lng,
  planning,
  controls,
  narrative,
  logoBuffer,
}) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    autoFirstPage: true,
    bufferPages: true,
  });

  const stream = new PassThrough();
  const chunks = [];
  stream.on("data", (c) => chunks.push(c));

  doc.pipe(stream);

  const nowIso = new Date().toISOString();
  const reportDate = new Date().toLocaleDateString("en-AU", {
    year: "numeric",
    month: "long",
    day: "2-digit",
  });

  // -----------------------------
  // Helpers
  // -----------------------------
  const pageW = () => doc.page.width;
  const pageH = () => doc.page.height;
  const contentW = () =>
    pageW() - doc.page.margins.left - doc.page.margins.right;

  function h1(text) {
    doc
      .font("Helvetica-Bold")
      .fontSize(22)
      .fillColor("#0B1220")
      .text(text, doc.page.margins.left, doc.y, { width: contentW() });
    doc.moveDown(0.6);
  }

  function h2(text) {
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor("#0B1220")
      .text(text, { width: contentW() });
    doc.moveDown(0.4);
  }

  function body(text, opts = {}) {
    doc
      .font("Helvetica")
      .fontSize(10.5)
      .fillColor("#24324B")
      .text(text, { width: contentW(), ...opts });
  }

  function kvRow(label, value) {
    const x = doc.page.margins.left;
    const w = contentW();
    const leftW = Math.floor(w * 0.33);

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#0B1220")
      .text(label, x, doc.y, {
        width: leftW,
        continued: true,
      });

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#24324B")
      .text(value ?? "-", {
        width: w - leftW,
      });

    doc.moveDown(0.25);
  }

  function footer() {
    const bottomY = pageH() - doc.page.margins.bottom + 10;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#6B7A99")
      .text(
        `Generated: ${reportDate}  •  ${schemeVersion || "City Plan 2014"}`,
        doc.page.margins.left,
        bottomY,
        {
          width: contentW(),
        }
      );
  }

  function drawPanel(x, y, w, h, title) {
    doc.roundedRect(x, y, w, h, 10).fillAndStroke("#F5F7FB", "#E0E6F3");

    if (title) {
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor("#0B1220")
        .text(title, x + 12, y + 10, { width: w - 24 });
    }
  }

  function drawImageOrPlaceholder({ buffer, x, y, w, h, title, failText }) {
    drawPanel(x, y, w, h, title);

    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#6B7A99")
        .text(failText || "Map image unavailable.", x + 12, y + 32, {
          width: w - 24,
        });
      return;
    }

    // Keep image inside panel with padding
    const pad = 12;
    const ix = x + pad;
    const iy = y + pad + (title ? 14 : 0);
    const iw = w - pad * 2;
    const ih = h - pad * 2 - (title ? 14 : 0);

    try {
      doc.image(buffer, ix, iy, {
        fit: [iw, ih],
        align: "center",
        valign: "center",
      });
    } catch (e) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#6B7A99")
        .text(`Map render failed: ${String(e?.message || e)}`, x + 12, y + 32, {
          width: w - 24,
        });
    }
  }

  // Match overlay "planning.overlays" to geometry in "planning.overlayPolygons"
  function findOverlayGeometryByCode(code) {
    const arr = planning?.overlayPolygons || [];
    return arr.find((p) => p?.code === code)?.geometry || null;
  }

  // Choose parcel geometry source
  const parcelGeoJSON =
    planning?.siteParcelPolygon || planning?.propertyParcel?.geometry || null;

  // -----------------------------
  // Cover Page
  // -----------------------------
  // Header row: logo + title
  const coverTopY = 40;

  if (logoBuffer && Buffer.isBuffer(logoBuffer) && logoBuffer.length > 0) {
    try {
      doc.image(logoBuffer, doc.page.margins.left, coverTopY, { width: 140 });
    } catch {
      // ignore logo failures
    }
  }

  doc.y = coverTopY + 55;
  h1("Property Planning Report (V2)");
  body(addressLabel || "Address unavailable");
  doc.moveDown(0.2);
  body(`Place ID: ${placeId || "-"}`);
  body(`Coordinates: ${lat}, ${lng}`);
  doc.moveDown(0.6);

  // Cover map
  const coverMap = await getParcelMapImageBufferV2({
    lat,
    lng,
    parcelGeoJSON,
    width: 1280,
    height: 720,
    zoom: 17,
    maptype: "hybrid",
    scale: 2,
  });

  drawImageOrPlaceholder({
    buffer: coverMap,
    x: doc.page.margins.left,
    y: doc.y,
    w: contentW(),
    h: 320,
    title: "Site context map",
    failText:
      "Could not fetch the static map. This usually means the parcel geometry is missing or the request was rejected.",
  });

  doc.y = doc.y + 340;
  footer();

  // -----------------------------
  // Summary Page
  // -----------------------------
  doc.addPage();
  h1("Planning Summary");

  h2("Zoning");
  kvRow("Zone code", planning?.zoningCode || "-");
  kvRow("Zone name", planning?.zoningName || "-");

  doc.moveDown(0.4);
  h2("Neighbourhood plan");
  kvRow("Neighbourhood plan", planning?.neighbourhoodPlan || "-");
  kvRow("Precinct", planning?.neighbourhoodPlanPrecinctCode || "-");

  doc.moveDown(0.4);
  h2("Overlays (intersections)");
  const overlays = planning?.overlays || [];
  if (!overlays.length) {
    body("No overlay intersections returned for this site.");
  } else {
    overlays.forEach((o) => {
      const area = o?.intersectionAreaM2
        ? `${Math.round(o.intersectionAreaM2).toLocaleString("en-AU")} m²`
        : "-";
      body(`• ${o?.name || o?.code || "Overlay"} — ${area}`);
    });
  }

  doc.moveDown(0.8);

  // Summary map again (smaller)
  const summaryMap = await getParcelMapImageBufferV2({
    lat,
    lng,
    parcelGeoJSON,
    width: 1280,
    height: 720,
    zoom: 18,
    maptype: "roadmap",
    scale: 2,
  });

  drawImageOrPlaceholder({
    buffer: summaryMap,
    x: doc.page.margins.left,
    y: doc.y,
    w: contentW(),
    h: 280,
    title: "Parcel boundary",
  });

  doc.y = doc.y + 300;
  footer();

  // -----------------------------
  // Overlay Pages (map-driven “visual punch”)
  // -----------------------------
  for (const o of overlays) {
    doc.addPage();

    const overlayCode = o?.code;
    const overlayName = o?.name || overlayCode || "Overlay";
    const overlayArea = o?.intersectionAreaM2
      ? `${Math.round(o.intersectionAreaM2).toLocaleString("en-AU")} m²`
      : "-";

    h1(overlayName);
    body(`Overlay code: ${overlayCode || "-"}\nIntersect area: ${overlayArea}`);
    doc.moveDown(0.6);

    const overlayGeoJSON = overlayCode
      ? findOverlayGeometryByCode(overlayCode)
      : null;

    const overlayMap = await getParcelOverlayMapImageBufferV2({
      lat,
      lng,
      parcelGeoJSON,
      overlayGeoJSON,
      width: 1280,
      height: 720,
      zoom: 18,
      maptype: "hybrid",
      scale: 2,
    });

    drawImageOrPlaceholder({
      buffer: overlayMap,
      x: doc.page.margins.left,
      y: doc.y,
      w: contentW(),
      h: 360,
      title: "Overlay map (parcel + overlay highlight)",
      failText:
        "Overlay map unavailable. Likely: overlay geometry missing from planning.overlayPolygons or request rejected.",
    });

    doc.y = doc.y + 380;

    // Optional narrative snippet, if present
    const narrativeOverlayNotes =
      narrative?.overlays?.find?.((x) => x?.code === overlayCode)?.summary ||
      narrative?.overlayNotes?.[overlayCode] ||
      null;

    if (narrativeOverlayNotes) {
      h2("Notes");
      body(String(narrativeOverlayNotes));
    }

    footer();
  }

  // -----------------------------
  // Controls + Narrative (text only)
  // -----------------------------
  doc.addPage();
  h1("Assessment Summary");

  h2("Key controls (from database)");
  kvRow(
    "Scheme version",
    controls?.schemeVersion || schemeVersion || "City Plan 2014"
  );
  kvRow(
    "Zone",
    `${planning?.zoningCode || "-"} — ${planning?.zoningName || "-"}`
  );
  kvRow("Neighbourhood plan", planning?.neighbourhoodPlan || "-");
  kvRow("Precinct", planning?.neighbourhoodPlanPrecinctCode || "-");

  doc.moveDown(0.6);

  if (narrative?.summary) {
    h2("Narrative summary");
    body(String(narrative.summary));
    doc.moveDown(0.4);
  }

  if (narrative?.disclaimer) {
    h2("Disclaimer");
    body(String(narrative.disclaimer));
  } else {
    h2("Disclaimer");
    body(
      "This report is informational only. Always confirm requirements directly against the Brisbane City Plan 2014 and official City Plan mapping before lodging applications."
    );
  }

  footer();

  // Finalize
  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return Buffer.concat(chunks);
}
