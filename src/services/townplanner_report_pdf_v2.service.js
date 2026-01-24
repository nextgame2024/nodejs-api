import PDFDocument from "pdfkit";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
} from "./googleStaticMaps_v2.service.js";

export const PDF_ENGINE_VERSION = "TPR-PDFKIT-V3-2026-01-24";

/**
 * Town Planner Report PDF (PDFKit)
 *
 * This implementation intentionally avoids any “auto-layout” abstractions that
 * previously caused page duplication / blank trailing pages.
 */

// --- Theme ---
const THEME = {
  page: {
    size: "A4",
    margin: 48,
  },
  colors: {
    ink: "#111827",
    muted: "#6B7280",
    border: "#E5E7EB",
    panel: "#F8FAFC",
    header: "#0B2A2A",
    brand: "#6D5EF7",
    white: "#FFFFFF",
  },
  typography: {
    h1: 24,
    h2: 18,
    h3: 13,
    body: 10,
    small: 8,
  },
  radius: 14,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeText(v, fallback = "Not mapped") {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function toIsoDay(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function roundedRectPath(doc, x, y, w, h, r) {
  const rr = clamp(r, 0, Math.min(w, h) / 2);
  doc
    .moveTo(x + rr, y)
    .lineTo(x + w - rr, y)
    .quadraticCurveTo(x + w, y, x + w, y + rr)
    .lineTo(x + w, y + h - rr)
    .quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
    .lineTo(x + rr, y + h)
    .quadraticCurveTo(x, y + h, x, y + h - rr)
    .lineTo(x, y + rr)
    .quadraticCurveTo(x, y, x + rr, y)
    .closePath();
}

function drawHeaderBar(doc, { title, rightLabel, address }) {
  const { margin } = THEME.page;
  const w = doc.page.width - margin * 2;
  const h = 34;
  const x = margin;
  const y = margin - 6;

  doc.save();
  doc.fillColor(THEME.colors.header);
  roundedRectPath(doc, x, y, w, h, 14);
  doc.fill();

  // left brand
  doc
    .fillColor(THEME.colors.brand)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("sophiaAi", x + 16, y + 10, { width: 120 });

  // center title
  doc
    .fillColor(THEME.colors.white)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(title, x, y + 10, { width: w, align: "center" });

  // right label
  doc
    .fillColor(THEME.colors.white)
    .font("Helvetica")
    .fontSize(9)
    .text(rightLabel, x + w - 120 - 16, y + 11, {
      width: 120,
      align: "right",
    });

  doc.restore();

  // address line
  doc
    .fillColor(THEME.colors.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(address, margin, y + h + 10);

  // divider line
  doc
    .strokeColor(THEME.colors.border)
    .lineWidth(1)
    .moveTo(margin, y + h + 26)
    .lineTo(doc.page.width - margin, y + h + 26)
    .stroke();
}

function drawFooter(doc, { templateVersion }) {
  const { margin } = THEME.page;
  const y = doc.page.height - margin + 18;
  doc
    .fillColor(THEME.colors.muted)
    .font("Helvetica")
    .fontSize(8)
    .text(`Brisbane Town Planner • sophiaAi • ${templateVersion}`, margin, y, {
      width: doc.page.width - margin * 2,
      align: "center",
    });
}

function drawPanel(doc, x, y, w, h, { fill = THEME.colors.panel } = {}) {
  doc.save();
  doc.fillColor(fill);
  doc.strokeColor(THEME.colors.border);
  doc.lineWidth(1);
  roundedRectPath(doc, x, y, w, h, THEME.radius);
  doc.fillAndStroke();
  doc.restore();
}

function drawImageInRoundedBox(doc, imgBuffer, x, y, w, h, { radius } = {}) {
  const r = radius ?? THEME.radius;
  doc.save();
  roundedRectPath(doc, x, y, w, h, r);
  doc.clip();

  // Use `fit` and match container aspect ratios to image aspect ratios to avoid
  // “empty right space” while also preventing polygon cropping.
  doc.image(imgBuffer, x, y, {
    fit: [w, h],
    align: "center",
    valign: "center",
  });

  doc.restore();

  // border
  doc.save();
  doc.strokeColor(THEME.colors.border).lineWidth(1);
  roundedRectPath(doc, x, y, w, h, r);
  doc.stroke();
  doc.restore();
}

function addH1(doc, text, y) {
  const { margin } = THEME.page;
  doc
    .fillColor(THEME.colors.ink)
    .font("Helvetica-Bold")
    .fontSize(THEME.typography.h1)
    .text(text, margin, y);
  return doc.y;
}

function addLead(doc, text) {
  const { margin } = THEME.page;
  doc
    .fillColor(THEME.colors.muted)
    .font("Helvetica")
    .fontSize(10)
    .text(text, margin, doc.y + 4);
  return doc.y;
}

function addSectionTitle(doc, label) {
  doc
    .fillColor(THEME.colors.ink)
    .font("Helvetica-Bold")
    .fontSize(THEME.typography.h2)
    .text(label, THEME.page.margin, doc.y + 18);
  return doc.y;
}

function normalizePayload(reportPayload) {
  // Accept both a single object and the older (reportPayload, opts) style.
  const payload = reportPayload || {};

  // Common fields from your generator service.
  const schemeVersion = payload.schemeVersion || payload.scheme_version || "";
  const addressLabel = payload.addressLabel || payload.address || "";
  const templateVersion =
    payload.templateVersion ||
    payload.reportTemplateVersion ||
    process.env.REPORT_TEMPLATE_VERSION ||
    process.env.PDF_ENGINE_VERSION ||
    "TPR-PDFKIT-V3";

  // Planning snapshot
  const planning = payload.planningSnapshot || payload.planning || {};

  // Narrative/report JSON
  const report =
    payload.reportJson || payload.report || payload.narrative || {};

  return { schemeVersion, addressLabel, templateVersion, planning, report };
}

function extractKeyValues({ planning, report }) {
  // Try to be resilient across data shapes.
  const zoning =
    report?.zoning?.code ||
    planning?.zoning?.code ||
    planning?.zone?.code ||
    report?.zoneCode;

  const zoneName =
    report?.zoning?.name ||
    planning?.zoning?.name ||
    planning?.zone?.name ||
    report?.zoneName;

  const npp =
    report?.neighbourhoodPlan?.name ||
    planning?.neighbourhoodPlan?.name ||
    report?.neighbourhood_plan?.name;

  const precinct =
    report?.neighbourhoodPlan?.precinct ||
    planning?.neighbourhoodPlan?.precinct ||
    report?.precinct;

  const cautions =
    report?.overlays?.map((o) => o?.name || o?.code).filter(Boolean) ||
    planning?.overlays?.map((o) => o?.name || o?.code).filter(Boolean) ||
    [];

  return {
    zoneCode: safeText(zoning),
    zoneName: safeText(zoneName, "Not mapped"),
    neighbourhoodPlan: safeText(npp, "Not mapped"),
    precinct: safeText(precinct, "Not mapped"),
    cautions,
  };
}

function extractGeometry(planning) {
  // Parcel geometry / point
  const lat =
    planning?.lat ||
    planning?.location?.lat ||
    planning?.parcel?.centroid?.lat ||
    planning?.parcelCentroid?.lat;
  const lng =
    planning?.lng ||
    planning?.location?.lng ||
    planning?.parcel?.centroid?.lng ||
    planning?.parcelCentroid?.lng;

  // Parcel polygon
  const parcelFeature =
    planning?.parcelFeature ||
    planning?.parcel?.feature ||
    planning?.parcelGeoJson ||
    planning?.parcel?.geojson ||
    null;

  // Zoning polygon (optional)
  const zoningFeature =
    planning?.zoningFeature ||
    planning?.zoning?.feature ||
    planning?.zoningGeoJson ||
    null;

  // Overlay features (array)
  const overlays =
    planning?.overlayFeatures ||
    planning?.overlays ||
    planning?.overlayGeoJson ||
    [];

  const overlayItems = Array.isArray(overlays)
    ? overlays
        .map((o) => {
          const code = o?.code || o?.overlay_code || o?.id || o?.name;
          const name = o?.name || o?.overlay_name || code;
          const feature = o?.feature || o?.geojson || o?.geometry || o;
          const summary =
            o?.summary ||
            o?.description ||
            o?.text ||
            `The property is affected by ${safeText(name, "this overlay")}.`;
          return {
            code: safeText(code),
            name: safeText(name),
            feature,
            summary,
          };
        })
        .filter((x) => x?.feature)
    : [];

  return { lat, lng, parcelFeature, zoningFeature, overlayItems };
}

async function buildMaps({
  lat,
  lng,
  parcelFeature,
  zoningFeature,
  overlayItems,
}) {
  // Map sizing strategy:
  // - Page-wide maps use 16:9 (1280x720 @2x) -> matches containers.
  // - Overlay cards also use 16:9.
  // - Parcel summary map uses 16:9.
  const results = {
    parcelMap: null,
    zoningMap: null,
    overlayMaps: [],
  };

  const tasks = [];

  // Parcel map
  if (lat && lng && parcelFeature) {
    tasks.push(
      getParcelMapImageBufferV2({
        lat,
        lng,
        parcelFeature,
        // 16:9
        size: "640x360",
        scale: 2,
      }).then((buf) => {
        results.parcelMap = buf;
      })
    );
  }

  // Zoning map: prefer zoningFeature if present, otherwise parcel polygon only
  if (lat && lng && (zoningFeature || parcelFeature)) {
    tasks.push(
      getParcelOverlayMapImageBufferV2({
        lat,
        lng,
        parcelFeature,
        overlayFeature: zoningFeature || parcelFeature,
        overlayStyle: { strokeColor: "0x0284C7", fillColor: "0x0284C733" },
        size: "640x360",
        scale: 2,
      }).then((buf) => {
        results.zoningMap = buf;
      })
    );
  }

  // Overlays
  overlayItems.forEach((ov) => {
    if (!lat || !lng || !parcelFeature || !ov?.feature) return;
    tasks.push(
      getParcelOverlayMapImageBufferV2({
        lat,
        lng,
        parcelFeature,
        overlayFeature: ov.feature,
        // Let the map service decide best fit; we just provide a style.
        overlayStyle: ov.overlayStyle || undefined,
        size: "640x360",
        scale: 2,
      }).then((buf) => {
        results.overlayMaps.push({ code: ov.code, buffer: buf });
      })
    );
  });

  await Promise.allSettled(tasks);
  return results;
}

function startNewPage(doc, { title, rightLabel, address, templateVersion }) {
  if (doc.page && doc._pageBuffer && doc._pageBuffer.length > 0) {
    doc.addPage();
  }
  drawHeaderBar(doc, { title, rightLabel, address });
  drawFooter(doc, { templateVersion });
}

function addContentsPage(doc, { toc, rightLabel, address, templateVersion }) {
  startNewPage(doc, {
    title: "Contents",
    rightLabel,
    address,
    templateVersion,
  });

  const { margin } = THEME.page;

  addH1(doc, "Report contents", margin + 60);
  doc.y += 2;
  addLead(doc, "Sections included in this report.");

  const cardX = margin;
  const cardY = doc.y + 18;
  const cardW = doc.page.width - margin * 2;
  const cardH = 360;

  drawPanel(doc, cardX, cardY, cardW, cardH);

  // Layout inside the card
  const leftX = cardX + 20;
  const rightX = cardX + cardW - 20;

  const rowH = 30;
  let y = cardY + 18;

  // Provide more right padding for the page numbers.
  const pageNumBoxW = 52;
  const pageNumX = rightX - pageNumBoxW;
  const dotsEndX = pageNumX - 14;

  doc.fontSize(10).font("Helvetica-Bold").fillColor(THEME.colors.ink);

  toc.forEach((item) => {
    // label
    doc.text(item.label, leftX, y, { width: dotsEndX - leftX - 10 });

    // dot leaders
    const labelWidth = doc.widthOfString(item.label);
    const dotsStart = leftX + labelWidth + 12;
    const dotsY = y + 12;

    doc.save();
    doc
      .strokeColor("#D1D5DB")
      .lineWidth(1)
      .dash(1, { space: 4 })
      .moveTo(dotsStart, dotsY)
      .lineTo(dotsEndX, dotsY)
      .stroke()
      .undash();
    doc.restore();

    // page number (right-aligned with padding)
    doc
      .font("Helvetica-Bold")
      .fillColor(THEME.colors.ink)
      .text(String(item.page), pageNumX, y, {
        width: pageNumBoxW,
        align: "right",
      });

    y += rowH;
  });

  // disclaimer line
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(THEME.colors.muted)
    .text(
      "Maps are indicative only. For authoritative mapping and controls, verify against Brisbane City Plan mapping and relevant sources.",
      margin,
      cardY + cardH + 12,
      { width: cardW }
    );
}

function addCoverPage(doc, { address, rightLabel, templateVersion, coverMap }) {
  // Cover uses the initial page (no addPage)
  drawHeaderBar(doc, {
    title: "Property Planning Report",
    rightLabel,
    address,
  });
  drawFooter(doc, { templateVersion });

  const { margin } = THEME.page;

  doc.y = margin + 70;

  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(THEME.colors.ink)
    .text("Property Planning Report", margin, doc.y);

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(THEME.colors.muted)
    .text(
      "Indicative planning information and mapped overlays.",
      margin,
      doc.y + 6
    );

  const mapX = margin;
  const mapY = doc.y + 18;
  const mapW = doc.page.width - margin * 2;
  const mapH = Math.round(mapW * (9 / 16));

  drawPanel(doc, mapX, mapY, mapW, mapH);
  if (coverMap) {
    drawImageInRoundedBox(doc, coverMap, mapX, mapY, mapW, mapH, {
      radius: THEME.radius,
    });
  } else {
    doc
      .fillColor(THEME.colors.muted)
      .fontSize(10)
      .text("Map unavailable", mapX, mapY + mapH / 2 - 5, {
        width: mapW,
        align: "center",
      });
  }
}

function addExecutiveSummary(
  doc,
  { address, rightLabel, templateVersion, keyValues, parcelMap }
) {
  startNewPage(doc, {
    title: "Executive summary",
    rightLabel,
    address,
    templateVersion,
  });

  const { margin } = THEME.page;

  addH1(doc, "Planning summary", margin + 60);

  const mapX = margin;
  const mapY = doc.y + 14;
  const mapW = doc.page.width - margin * 2;
  const mapH = Math.round(mapW * (9 / 16));

  drawPanel(doc, mapX, mapY, mapW, mapH);
  if (parcelMap) {
    drawImageInRoundedBox(doc, parcelMap, mapX, mapY, mapW, mapH);
  }

  // Two info cards
  const cardGap = 14;
  const cardY = mapY + mapH + 18;
  const cardW = (mapW - cardGap) / 2;
  const cardH = 118;

  const card1X = mapX;
  const card2X = mapX + cardW + cardGap;

  drawPanel(doc, card1X, cardY, cardW, cardH);
  drawPanel(doc, card2X, cardY, cardW, cardH);

  // Card content
  const pad = 14;

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(THEME.colors.ink)
    .text("Zoning", card1X + pad, cardY + pad);

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(THEME.colors.muted)
    .text("Zone code", card1X + pad, cardY + pad + 22);

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(THEME.colors.ink)
    .text(keyValues.zoneCode, card1X + pad, cardY + pad + 36);

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(THEME.colors.muted)
    .text("Zone name", card1X + pad, cardY + pad + 58);

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(THEME.colors.ink)
    .text(keyValues.zoneName, card1X + pad, cardY + pad + 72, {
      width: cardW - pad * 2,
    });

  // Card 2
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(THEME.colors.ink)
    .text("Neighbourhood plan", card2X + pad, cardY + pad);

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(THEME.colors.muted)
    .text("Plan", card2X + pad, cardY + pad + 22);

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(THEME.colors.ink)
    .text(keyValues.neighbourhoodPlan, card2X + pad, cardY + pad + 36, {
      width: cardW - pad * 2,
    });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(THEME.colors.muted)
    .text("Precinct", card2X + pad, cardY + pad + 62);

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(THEME.colors.ink)
    .text(keyValues.precinct, card2X + pad, cardY + pad + 76, {
      width: cardW - pad * 2,
    });

  // Cautions
  const cautionsY = cardY + cardH + 14;
  const cautionsH = 88;

  drawPanel(doc, mapX, cautionsY, mapW, cautionsH);

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(THEME.colors.ink)
    .text("Potential cautions (overlays)", mapX + pad, cautionsY + pad);

  const bullets = (keyValues.cautions || []).slice(0, 6);
  if (bullets.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(THEME.colors.muted)
      .text(
        "None identified from current spatial inputs.",
        mapX + pad,
        cautionsY + pad + 24
      );
  } else {
    doc.font("Helvetica").fontSize(9).fillColor(THEME.colors.ink);

    let by = cautionsY + pad + 24;
    bullets.forEach((b) => {
      doc.text(`• ${b}`, mapX + pad, by, { width: mapW - pad * 2 });
      by += 16;
    });
  }
}

function addZoningSection(
  doc,
  { address, rightLabel, templateVersion, zoningMap, keyValues }
) {
  startNewPage(doc, { title: "Zoning", rightLabel, address, templateVersion });

  const { margin } = THEME.page;

  addSectionTitle(doc, "Zoning map");

  const mapX = margin;
  const mapY = doc.y + 14;
  const mapW = doc.page.width - margin * 2;
  const mapH = Math.round(mapW * (9 / 16));

  drawPanel(doc, mapX, mapY, mapW, mapH);
  if (zoningMap) {
    drawImageInRoundedBox(doc, zoningMap, mapX, mapY, mapW, mapH);
  }

  const notesY = mapY + mapH + 14;
  const notesH = 100;

  drawPanel(doc, mapX, notesY, mapW, notesH);

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(THEME.colors.ink)
    .text("Notes", mapX + 14, notesY + 14);

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(THEME.colors.muted)
    .text(
      `Mapped zoning: ${keyValues.zoneCode}.\nConfirm boundaries and intent against Brisbane City Plan mapping and applicable codes.`,
      mapX + 14,
      notesY + 36,
      { width: mapW - 28 }
    );
}

function addDevelopmentControls(
  doc,
  { address, rightLabel, templateVersion, report }
) {
  startNewPage(doc, {
    title: "Development controls",
    rightLabel,
    address,
    templateVersion,
  });

  const { margin } = THEME.page;

  addSectionTitle(doc, "Development controls");
  doc.y += 6;

  const controls =
    report?.developmentControls ||
    report?.controls ||
    report?.development_controls ||
    [];

  const content = Array.isArray(controls) ? controls : [];

  if (!content.length) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(THEME.colors.muted)
      .text(
        "No specific development controls were returned for this address.",
        margin,
        doc.y + 10
      );
    return;
  }

  // Render as simple cards.
  const pageW = doc.page.width;
  const cardW = pageW - margin * 2;
  const pad = 14;

  let y = doc.y + 12;

  content.forEach((c) => {
    const title = safeText(c?.title || c?.name || "Control");
    const body = safeText(c?.summary || c?.text || c?.description || "");

    const estimatedH = 14 + 14 + 10 + (body.length > 180 ? 80 : 50);
    const cardH = clamp(estimatedH, 70, 170);

    // Page break
    if (y + cardH > doc.page.height - margin - 34) {
      startNewPage(doc, {
        title: "Development controls",
        rightLabel,
        address,
        templateVersion,
      });
      y = margin + 60;
    }

    drawPanel(doc, margin, y, cardW, cardH);

    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(THEME.colors.ink)
      .text(title, margin + pad, y + pad);

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(THEME.colors.muted)
      .text(body, margin + pad, y + pad + 18, { width: cardW - pad * 2 });

    y += cardH + 12;
  });
}

function addPotentialCautions(
  doc,
  { address, rightLabel, templateVersion, overlayItems, overlayMaps }
) {
  startNewPage(doc, {
    title: "Potential cautions",
    rightLabel,
    address,
    templateVersion,
  });

  const { margin } = THEME.page;

  addSectionTitle(doc, "Potential cautions");
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(THEME.colors.muted)
    .text(
      "Overlays returned by current spatial inputs. Verify against authoritative mapping.",
      margin,
      doc.y + 6
    );

  const mapByCode = new Map(
    (overlayMaps || []).map((m) => [String(m.code), m.buffer])
  );

  const pageW = doc.page.width;
  const cardW = pageW - margin * 2;
  const pad = 14;

  // Fixed card height to keep layout stable and avoid overflow surprises.
  const cardH = 240;
  const mapRatio = 16 / 9;

  let y = doc.y + 14;

  overlayItems.forEach((ov) => {
    // Page break
    if (y + cardH > doc.page.height - margin - 34) {
      startNewPage(doc, {
        title: "Potential cautions",
        rightLabel,
        address,
        templateVersion,
      });
      y = margin + 60;
    }

    drawPanel(doc, margin, y, cardW, cardH);

    // Header row
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(THEME.colors.ink)
      .text(safeText(ov.name), margin + pad, y + pad);

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(THEME.colors.muted)
      .text(
        `Overlay code: ${safeText(ov.code)}  •  Intersect area: N/A`,
        margin + pad,
        y + pad + 18
      );

    // Inner layout: map left, summary right
    const innerX = margin + pad;
    const innerY = y + pad + 36;
    const innerW = cardW - pad * 2;
    const innerH = cardH - (pad + 36) - pad;

    // Reserve right column for summary.
    const summaryW = 190;
    const gap = 14;
    const mapW = innerW - summaryW - gap;

    // Match container height to 16:9 with minimal letterboxing.
    const desiredMapH = Math.round(mapW / mapRatio);
    const mapH = Math.min(innerH, desiredMapH);
    const mapY = innerY + Math.round((innerH - mapH) / 2);

    const mapX = innerX;
    const summaryX = mapX + mapW + gap;

    // Map container
    drawPanel(doc, mapX, mapY, mapW, mapH, { fill: THEME.colors.white });
    const buf = mapByCode.get(String(ov.code));
    if (buf) {
      drawImageInRoundedBox(doc, buf, mapX, mapY, mapW, mapH, {
        radius: 12,
      });
    } else {
      doc
        .fillColor(THEME.colors.muted)
        .font("Helvetica")
        .fontSize(9)
        .text("Map unavailable", mapX, mapY + mapH / 2 - 5, {
          width: mapW,
          align: "center",
        });
    }

    // Summary container
    drawPanel(doc, summaryX, innerY, summaryW, innerH, {
      fill: THEME.colors.white,
    });

    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(THEME.colors.ink)
      .text("Summary", summaryX + 12, innerY + 12);

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(THEME.colors.muted)
      .text(safeText(ov.summary), summaryX + 12, innerY + 32, {
        width: summaryW - 24,
        height: innerH - 44,
      });

    y += cardH + 14;
  });

  if (!overlayItems.length) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(THEME.colors.muted)
      .text("No overlays were returned for this address.", margin, doc.y + 10);
  }
}

function addReferences(doc, { address, rightLabel, templateVersion }) {
  startNewPage(doc, {
    title: "References & disclaimer",
    rightLabel,
    address,
    templateVersion,
  });

  const { margin } = THEME.page;

  addSectionTitle(doc, "References");
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(THEME.colors.ink)
    .text(
      "• Brisbane City Plan mapping\n• Queensland Globe\n• Brisbane City Council property and overlay mapping layers",
      margin,
      doc.y + 10
    );

  doc.y += 18;
  addSectionTitle(doc, "Disclaimer");
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(THEME.colors.muted)
    .text(
      "This report is generated from spatial inputs and data services that may change. Maps are indicative only and may not represent authoritative boundaries. Always confirm planning controls and overlays using official Brisbane City Plan mapping and relevant planning instruments. This report does not constitute legal advice.",
      margin,
      doc.y + 10,
      { width: doc.page.width - margin * 2 }
    );
}

export async function buildTownPlannerReportPdfV2(reportPayload) {
  const { schemeVersion, addressLabel, templateVersion, planning, report } =
    normalizePayload(reportPayload);

  const rightLabel = safeText(schemeVersion, "City Plan 2014");
  const address = safeText(addressLabel, "Address not provided");

  const keyValues = extractKeyValues({ planning, report });
  const { lat, lng, parcelFeature, zoningFeature, overlayItems } =
    extractGeometry(planning);

  const { parcelMap, zoningMap, overlayMaps } = await buildMaps({
    lat,
    lng,
    parcelFeature,
    zoningFeature,
    overlayItems,
  });

  const doc = new PDFDocument({
    size: THEME.page.size,
    margins: {
      top: THEME.page.margin,
      left: THEME.page.margin,
      right: THEME.page.margin,
      bottom: THEME.page.margin,
    },
    autoFirstPage: true,
  });

  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Cover uses the first page already created.
  addCoverPage(doc, {
    address,
    rightLabel,
    templateVersion,
    coverMap: parcelMap || zoningMap,
  });

  // TOC (starting pages are deterministic given our fixed-order sections).
  // Cover is page 1; Contents page will be page 2.
  // Executive summary starts page 3; Zoning page 4; Development controls page 5; Potential cautions page 6; References page 7.
  const toc = [
    { label: "Cover", page: 1 },
    { label: "Contents", page: 2 },
    { label: "Executive summary", page: 3 },
    { label: "Zoning", page: 4 },
    { label: "Development controls", page: 5 },
    { label: "Potential cautions", page: 6 },
    { label: "References & disclaimer", page: 7 },
  ];

  addContentsPage(doc, { toc, rightLabel, address, templateVersion });

  addExecutiveSummary(doc, {
    address,
    rightLabel,
    templateVersion,
    keyValues,
    parcelMap: parcelMap || zoningMap,
  });

  addZoningSection(doc, {
    address,
    rightLabel,
    templateVersion,
    zoningMap,
    keyValues,
  });

  addDevelopmentControls(doc, { address, rightLabel, templateVersion, report });

  addPotentialCautions(doc, {
    address,
    rightLabel,
    templateVersion,
    overlayItems,
    overlayMaps,
  });

  addReferences(doc, { address, rightLabel, templateVersion });

  doc.end();
  return done;
}
