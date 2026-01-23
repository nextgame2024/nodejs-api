// src/services/townplanner_report_pdf_v2.service.js
//
// V2 PDF generator (reference-style upgrade)
// - Cover + Contents
// - Snapshot + Zoning map page + Controls page
// - Grouped overlay pages (Flood / Noise / Character&Heritage / Airport) + Appendix
// - Uses Google Static Maps (server-side)

import PDFDocument from "pdfkit";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
  getParcelZoningMapImageBufferV2,
} from "./googleStaticMaps_v2.service.js";

function safe(v) {
  return v == null ? "" : String(v);
}

function fmtNumber(n, suffix = "") {
  const x = Number(n);
  if (!Number.isFinite(x)) return "N/A";
  return `${Math.round(x)}${suffix}`;
}

function todayAU() {
  try {
    return new Date().toLocaleDateString("en-AU", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// -------------------------
// Drawing helpers
// -------------------------

function drawTopBar(doc, { titleLeft, subtitleRight } = {}) {
  const { left, right, top } = doc.page.margins;
  const w = doc.page.width - left - right;
  const barH = 46;
  const x = left;
  const y = top - 10;

  doc.save();
  doc.rect(x, y, w, barH).fill("#0B2F2A");
  doc.fillColor("#FFFFFF");
  doc.fontSize(16).text(titleLeft || "Town Planner", x + 14, y + 13, {
    width: w * 0.65,
    ellipsis: true,
  });
  doc
    .fontSize(10)
    .fillColor("#DCE7E5")
    .text(subtitleRight || "", x, y + 17, {
      width: w - 14,
      align: "right",
      ellipsis: true,
    });
  doc.restore();

  doc.moveDown(2.2);
}

function drawFooter(
  doc,
  { brand = "Brisbane Town Planner", schemeVersion = "" } = {}
) {
  const { left, right, bottom } = doc.page.margins;
  const y = doc.page.height - bottom + 8;
  const w = doc.page.width - left - right;

  doc.save();
  doc.fontSize(8).fillColor("#666666");
  doc.text(`${brand} • ${schemeVersion}`.trim(), left, y, { width: w });
  doc.text(`Page ${doc.page.pageNumber}`, left, y, {
    width: w,
    align: "right",
  });
  doc.restore();
}

function sectionHeading(doc, text) {
  doc.moveDown(0.5);
  doc.fontSize(18).fillColor("#111111").text(text);
  doc.moveDown(0.25);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .lineWidth(1)
    .strokeColor("#E6E6E6")
    .stroke();
  doc.moveDown(0.8);
}

function keyValueGrid(doc, rows) {
  const { left, right } = doc.page.margins;
  const w = doc.page.width - left - right;
  const colW = w / 2;
  const rowH = 48;
  const yStart = doc.y;

  doc.save();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const col = i % 2;
    const row = Math.floor(i / 2);

    const bx = left + col * colW;
    const by = yStart + row * rowH;

    doc.rect(bx, by, colW - 8, rowH - 8).fill("#F7F7F7");
    doc
      .fillColor("#666666")
      .fontSize(9)
      .text(safe(r.k).toUpperCase(), bx + 10, by + 8, {
        width: colW - 28,
        ellipsis: true,
      });
    doc
      .fillColor("#111111")
      .fontSize(12)
      .text(safe(r.v), bx + 10, by + 24, {
        width: colW - 28,
        ellipsis: true,
      });
  }
  doc.restore();

  const rowsUsed = Math.ceil(rows.length / 2);
  doc.y = yStart + rowsUsed * rowH;
  doc.moveDown(0.6);
}

function bulletList(doc, items, { fontSize = 10, indent = 12 } = {}) {
  doc.save();
  doc.fontSize(fontSize).fillColor("#333333");
  for (const it of items || []) {
    const txt = safe(it);
    if (!txt) continue;
    doc.text(`• ${txt}`, { indent });
  }
  doc.restore();
}

function smallPara(doc, text) {
  doc.fontSize(10).fillColor("#333333").text(safe(text));
  doc.moveDown(0.6);
}

// -------------------------
// Content helpers
// -------------------------

function getParcelGeometry(planning) {
  return (
    planning?.siteParcelPolygon || planning?.propertyParcel?.geometry || null
  );
}

function getZoningGeometry(planning) {
  // tolerate multiple shapes
  return (
    planning?.zoningPolygon?.geometry ||
    planning?.zoningPolygon ||
    planning?.zoning?.geometry ||
    null
  );
}

function getOverlayGeometryByCode(planning, code) {
  const arr = planning?.overlayPolygons || [];
  const found = arr.find((x) => x?.code === code);
  return found?.geometry || null;
}

function controlsValue(controls, key) {
  const v = controls?.mergedControls?.[key];
  if (v == null || String(v).trim() === "") return "N/A";
  return String(v);
}

function findCautionItem(narrative, overlayName) {
  const items =
    (narrative?.sections || []).find((s) => s?.id === "cautions")?.items || [];
  const n = safe(overlayName).toLowerCase();

  return (
    items.find((i) => safe(i?.title).toLowerCase() === n) ||
    items.find((i) => safe(i?.title).toLowerCase().includes(n.slice(0, 12))) ||
    null
  );
}

function classifyOverlay(ov) {
  const code = safe(ov?.code).toLowerCase();
  const name = safe(ov?.name).toLowerCase();

  // Prefer explicit code matching if your service emits stable codes.
  if (code.includes("flood") || name.includes("flood")) return "flood";
  if (code.includes("noise") || name.includes("noise")) return "noise";
  if (code.includes("character") || name.includes("character"))
    return "character";
  if (
    code.includes("heritage") ||
    name.includes("heritage") ||
    name.includes("pre-1911") ||
    name.includes("pre 1911")
  )
    return "character";
  if (
    code.includes("airport") ||
    name.includes("airport") ||
    name.includes("height restriction")
  )
    return "airport";

  return "appendix";
}

function pickPrimaryOverlay(groupOverlays) {
  // If multiple exist, pick the first. You can refine order later (severity ordering).
  return groupOverlays?.[0] || null;
}

// -------------------------
// Main generator
// -------------------------

export function buildTownPlannerReportPdfV2({
  schemeVersion,
  addressLabel,
  planning,
  controls,
  narrative,
  logoBuffer,
}) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        autoFirstPage: true,
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const parcelGeo = getParcelGeometry(planning);
      const zoningGeo = getZoningGeometry(planning);

      const overlays = planning?.overlays || [];
      const grouped = {
        flood: [],
        noise: [],
        character: [],
        airport: [],
        appendix: [],
      };

      for (const ov of overlays) {
        grouped[classifyOverlay(ov)].push(ov);
      }

      // Build section plan (each section is one page)
      // Page numbers are deterministic:
      // 1 Cover, 2 Contents, then these sections sequentially.
      const sections = [];

      sections.push({ id: "snapshot", title: "Property snapshot" });
      sections.push({ id: "zoning", title: "Zoning (map)" });
      sections.push({ id: "controls", title: "Development controls" });

      if (grouped.flood.length)
        sections.push({ id: "flood", title: "Flood constraints" });
      if (grouped.noise.length)
        sections.push({ id: "noise", title: "Transport noise" });
      if (grouped.character.length)
        sections.push({ id: "character", title: "Character & heritage" });
      if (grouped.airport.length)
        sections.push({ id: "airport", title: "Airport environment & height" });
      if (grouped.appendix.length)
        sections.push({
          id: "appendix",
          title: "Appendix: other mapped overlays",
        });

      sections.push({ id: "disclaimer", title: "References & disclaimer" });

      const tocEntries = sections.map((s, idx) => ({
        title: s.title,
        page: 3 + idx,
      }));

      // -------------------------
      // Cover page
      // -------------------------
      doc.save();

      const { left, right, top } = doc.page.margins;
      const w = doc.page.width - left - right;

      doc.rect(left, top - 10, w, 240).fill("#0B2F2A");

      if (logoBuffer) {
        try {
          doc.image(logoBuffer, left + 14, top + 20, { width: 140 });
        } catch {}
      }

      doc
        .fillColor("#FFFFFF")
        .fontSize(26)
        .text("Property Report", left + 14, top + 88, { width: w - 28 });
      doc
        .fillColor("#DCE7E5")
        .fontSize(12)
        .text(safe(addressLabel), left + 14, top + 126, { width: w - 28 });
      doc
        .fillColor("#DCE7E5")
        .fontSize(10)
        .text(`Report generated ${todayAU()}`, left + 14, top + 150, {
          width: w - 28,
        });
      doc
        .fillColor("#DCE7E5")
        .fontSize(10)
        .text(`Planning scheme: ${schemeVersion}`, left + 14, top + 166, {
          width: w - 28,
        });

      if (parcelGeo) {
        try {
          const coverMap = await getParcelMapImageBufferV2({
            parcelGeoJSON: parcelGeo,
            size: "640x420",
            maptype: process.env.STATIC_MAP_TYPE || "hybrid",
          });

          if (coverMap) {
            const cardY = top + 225;
            doc.rect(left, cardY, w, 285).fill("#FFFFFF");
            doc.image(coverMap, left + 10, cardY + 10, {
              fit: [w - 20, 265],
              align: "center",
            });
          }
        } catch {}
      }

      doc.restore();
      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Contents
      // -------------------------
      drawTopBar(doc, {
        titleLeft: "Contents",
        subtitleRight: safe(addressLabel),
      });
      sectionHeading(doc, "Report contents");

      doc.fontSize(11).fillColor("#111111");
      for (const e of tocEntries) {
        const lineY = doc.y;
        doc.text(e.title, { continued: true });
        const dotsW = 420 - doc.widthOfString(e.title);
        const dots = ".".repeat(Math.max(3, Math.floor(dotsW / 6)));
        doc.fillColor("#777777").text(` ${dots} `, { continued: true });
        doc.fillColor("#111111").text(String(e.page), { align: "right" });
        doc.y = lineY + 18;
      }

      doc.moveDown(0.8);
      doc
        .fontSize(9)
        .fillColor("#555555")
        .text(
          "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping."
        );

      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Section: Snapshot
      // -------------------------
      drawTopBar(doc, {
        titleLeft: "Property Overview",
        subtitleRight: safe(addressLabel),
      });
      sectionHeading(doc, "Property snapshot");

      const zoningName = planning?.zoning || "Unknown";
      const neighbourhoodPlan = planning?.neighbourhoodPlan || "Not mapped";
      const precinct = planning?.neighbourhoodPlanPrecinct || "Not mapped";
      const areaM2 = planning?.propertyParcel?.debug?.areaM2;

      keyValueGrid(doc, [
        { k: "Address", v: safe(addressLabel) },
        { k: "Zoning", v: zoningName },
        { k: "Neighbourhood plan", v: neighbourhoodPlan },
        { k: "Precinct", v: precinct },
        {
          k: "Site area (approx.)",
          v: areaM2 ? `${fmtNumber(areaM2)} m²` : "N/A",
        },
        { k: "Maximum height", v: controlsValue(controls, "max_height") },
        { k: "Minimum lot size", v: controlsValue(controls, "min_lot_size") },
        { k: "Minimum frontage", v: controlsValue(controls, "min_frontage") },
      ]);

      const overviewSection = (narrative?.sections || []).find(
        (s) => s?.id === "overview"
      );
      if (overviewSection?.bullets?.length) {
        sectionHeading(doc, "Summary");
        bulletList(doc, overviewSection.bullets, { fontSize: 10 });
      }

      if (parcelGeo) {
        try {
          const mapBuf = await getParcelMapImageBufferV2({
            parcelGeoJSON: parcelGeo,
            size: "640x360",
            maptype: process.env.STATIC_MAP_TYPE || "hybrid",
          });
          if (mapBuf) {
            doc.moveDown(0.2);
            doc
              .fontSize(11)
              .fillColor("#111111")
              .text("Site location (parcel outline)");
            doc.moveDown(0.4);
            doc.image(mapBuf, { fit: [500, 280], align: "center" });
          }
        } catch {}
      }

      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Section: Zoning map
      // -------------------------
      drawTopBar(doc, {
        titleLeft: "Zoning",
        subtitleRight: safe(addressLabel),
      });
      sectionHeading(doc, "Zoning (map)");

      smallPara(
        doc,
        "This page highlights the mapped zoning for the subject site. Confirm boundaries and zone intent against Brisbane City Plan 2014 mapping."
      );

      doc
        .fontSize(11)
        .fillColor("#111111")
        .text(`Mapped zoning: ${safe(zoningName)}`);
      doc.moveDown(0.6);

      if (parcelGeo) {
        try {
          const zMap = await getParcelZoningMapImageBufferV2({
            parcelGeoJSON: parcelGeo,
            zoningGeoJSON: zoningGeo,
            size: "640x360",
            maptype: process.env.STATIC_MAP_TYPE || "hybrid",
          });

          if (zMap) doc.image(zMap, { fit: [500, 280], align: "center" });
          else {
            const fallback = await getParcelMapImageBufferV2({
              parcelGeoJSON: parcelGeo,
              size: "640x360",
              maptype: process.env.STATIC_MAP_TYPE || "hybrid",
            });
            if (fallback)
              doc.image(fallback, { fit: [500, 280], align: "center" });
          }
        } catch {}
      }

      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Section: Controls
      // -------------------------
      drawTopBar(doc, {
        titleLeft: "Development Controls",
        subtitleRight: safe(addressLabel),
      });
      sectionHeading(doc, "Key development controls (where available)");

      keyValueGrid(doc, [
        { k: "Maximum height", v: controlsValue(controls, "max_height") },
        { k: "Minimum lot size", v: controlsValue(controls, "min_lot_size") },
        { k: "Minimum frontage", v: controlsValue(controls, "min_frontage") },
        {
          k: "Maximum site coverage",
          v: controlsValue(controls, "site_cover"),
        },
        { k: "Plot ratio / GFA", v: controlsValue(controls, "plot_ratio") },
        { k: "Density (if applicable)", v: controlsValue(controls, "density") },
      ]);

      const devSection = (narrative?.sections || []).find(
        (s) => s?.id === "development"
      );
      sectionHeading(doc, safe(devSection?.title || "Development guidance"));

      if (devSection?.bullets?.length)
        bulletList(doc, devSection.bullets, { fontSize: 10 });
      else {
        smallPara(
          doc,
          "Narrative development guidance is not available. This section will expand as controls and Gemini output are refined."
        );
      }

      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Grouped overlay pages
      // -------------------------

      async function renderOverlayGroupPage({ title, intro, groupKey }) {
        drawTopBar(doc, {
          titleLeft: "Potential Cautions",
          subtitleRight: safe(addressLabel),
        });
        sectionHeading(doc, title);

        smallPara(doc, intro);

        const list = grouped[groupKey] || [];
        const lines = [];

        for (const ov of list) {
          const ci = findCautionItem(narrative, ov?.name);
          if (ci?.summary) lines.push(`${ov.name}: ${ci.summary}`);
          else
            lines.push(
              `${ov.name}: Mapped over or near the site. Review applicable overlay mapping and code.`
            );
        }

        bulletList(doc, lines, { fontSize: 9, indent: 10 });

        // Map highlight: primary overlay
        const primary = pickPrimaryOverlay(list);
        if (parcelGeo && primary) {
          try {
            const overlayGeo = getOverlayGeometryByCode(planning, primary.code);
            const mapBuf = await getParcelOverlayMapImageBufferV2({
              parcelGeoJSON: parcelGeo,
              overlayGeoJSON: overlayGeo,
              size: "640x360",
              maptype: process.env.STATIC_MAP_TYPE || "hybrid",
            });

            if (mapBuf) {
              doc.moveDown(0.6);
              doc
                .fontSize(11)
                .fillColor("#111111")
                .text("Map view (primary mapped constraint)");
              doc.moveDown(0.4);
              doc.image(mapBuf, { fit: [500, 280], align: "center" });
            }
          } catch {}
        }

        drawFooter(doc, { schemeVersion });
      }

      if (grouped.flood.length) {
        await renderOverlayGroupPage({
          title: "Flood constraints",
          intro:
            "Flood-related overlays can trigger assessment and design requirements. This report shows mapped flood constraints intersecting the site based on current data inputs.",
          groupKey: "flood",
        });
        doc.addPage();
      }

      if (grouped.noise.length) {
        await renderOverlayGroupPage({
          title: "Transport noise",
          intro:
            "Transport noise overlays can affect building design (e.g., acoustic treatment) and assessment triggers. Confirm requirements against the overlay code and mapping legend.",
          groupKey: "noise",
        });
        doc.addPage();
      }

      if (grouped.character.length) {
        await renderOverlayGroupPage({
          title: "Character & heritage",
          intro:
            "Character/heritage-related overlays can constrain demolition, extensions, façade treatment and other built-form outcomes. Confirm applicable codes and mapped extents.",
          groupKey: "character",
        });
        doc.addPage();
      }

      if (grouped.airport.length) {
        await renderOverlayGroupPage({
          title: "Airport environment & height",
          intro:
            "Airport environment/height overlays can restrict maximum building height and require additional considerations. Confirm mapped restrictions and any related assessment triggers.",
          groupKey: "airport",
        });
        doc.addPage();
      }

      // -------------------------
      // Appendix
      // -------------------------
      if (grouped.appendix.length) {
        drawTopBar(doc, {
          titleLeft: "Appendix",
          subtitleRight: safe(addressLabel),
        });
        sectionHeading(doc, "Appendix: other mapped overlays");

        smallPara(
          doc,
          "The overlays below were detected but are not expanded into full pages in this version of the report. Review City Plan mapping and codes for detailed requirements."
        );

        bulletList(
          doc,
          grouped.appendix.map((o) => safe(o?.name)).filter(Boolean),
          { fontSize: 10, indent: 12 }
        );

        drawFooter(doc, { schemeVersion });
        doc.addPage();
      }

      // -------------------------
      // References + Disclaimer
      // -------------------------
      drawTopBar(doc, {
        titleLeft: "General Information",
        subtitleRight: safe(addressLabel),
      });
      sectionHeading(doc, "References");

      const refSection = (narrative?.sections || []).find(
        (s) => s?.id === "references"
      );
      const refs = refSection?.items?.length
        ? refSection.items
        : [schemeVersion];

      doc.fontSize(10).fillColor("#333333");
      for (const r of refs) doc.text(`• ${safe(r)}`);

      doc.moveDown(1.0);
      sectionHeading(doc, "Disclaimer");

      doc
        .fontSize(9)
        .fillColor("#333333")
        .text(
          safe(
            narrative?.disclaimer ||
              "This report is general information only and does not constitute legal advice. Data is sourced from publicly available mapping and may be incomplete or subject to change. You should verify requirements against Brisbane City Plan 2014 mapping and applicable codes before relying on this report."
          )
        );

      drawFooter(doc, { schemeVersion });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
