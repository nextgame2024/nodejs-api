// src/services/townplanner_report_pdf_v2.service.js
//
// V2 PDF generator (from scratch)
// - More structured layout (cover, snapshot, development, cautions with maps)
// - Uses Google Static Maps (server-side) for strong visual output
//
// Dependencies:
//   - pdfkit
//   - axios
//   - ./googleStaticMaps_v2.service.js

import PDFDocument from "pdfkit";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
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

// --- Drawing helpers ---------------------------------------------------------

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

  let x = left;
  let y = doc.y;

  doc.save();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const col = i % 2;
    const row = Math.floor(i / 2);

    const bx = left + col * colW;
    const by = y + row * rowH;

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
  doc.y = y + rowsUsed * rowH;
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

// --- Content helpers ---------------------------------------------------------

function getOverlayGeometryByCode(planning, code) {
  const arr = planning?.overlayPolygons || [];
  const found = arr.find((x) => x?.code === code);
  return found?.geometry || null;
}

function getParcelGeometry(planning) {
  return (
    planning?.siteParcelPolygon || planning?.propertyParcel?.geometry || null
  );
}

function controlsValue(controls, key) {
  const v = controls?.mergedControls?.[key];
  if (v == null || String(v).trim() === "") return "N/A";
  return String(v);
}

// --- Main generator ----------------------------------------------------------

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

      // -------------------------
      // Cover page
      // -------------------------
      doc.save();

      // Background band
      const { left, right, top } = doc.page.margins;
      const w = doc.page.width - left - right;
      doc.rect(left, top - 10, w, 240).fill("#0B2F2A");

      // Logo
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, left + 14, top + 20, { width: 140 });
        } catch {}
      }

      doc
        .fillColor("#FFFFFF")
        .fontSize(26)
        .text("Property Report", left + 14, top + 88, {
          width: w - 28,
        });

      doc
        .fillColor("#DCE7E5")
        .fontSize(12)
        .text(safe(addressLabel), left + 14, top + 126, {
          width: w - 28,
        });

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

      // Cover map (optional, high-impact)
      if (parcelGeo) {
        try {
          const coverMap = await getParcelMapImageBufferV2({
            parcelGeoJSON: parcelGeo,
            size: "640x420",
            maptype: process.env.STATIC_MAP_TYPE || "hybrid",
          });

          if (coverMap) {
            // White card container
            const cardY = top + 225;
            doc.rect(left, cardY, w, 285).fill("#FFFFFF");
            doc.image(coverMap, left + 10, cardY + 10, {
              fit: [w - 20, 265],
              align: "center",
            });
          }
        } catch {
          // ignore map failure; PDF still generates
        }
      }

      doc.restore();
      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Property overview
      // -------------------------
      drawTopBar(doc, {
        titleLeft: "Property Overview",
        subtitleRight: safe(addressLabel),
      });
      sectionHeading(doc, "Property snapshot");

      const zoning = planning?.zoning || "Unknown";
      const neighbourhoodPlan = planning?.neighbourhoodPlan || "Not mapped";
      const precinct = planning?.neighbourhoodPlanPrecinct || "Not mapped";
      const areaM2 = planning?.propertyParcel?.debug?.areaM2;

      // Controls are progressively seeded; show what we have
      const maxHeight = controlsValue(controls, "max_height");
      const minLotSize = controlsValue(controls, "min_lot_size");
      const minFrontage = controlsValue(controls, "min_frontage");

      keyValueGrid(doc, [
        { k: "Address", v: safe(addressLabel) },
        { k: "Zoning", v: zoning },
        { k: "Neighbourhood plan", v: neighbourhoodPlan },
        { k: "Precinct", v: precinct },
        {
          k: "Site area (approx.)",
          v: areaM2 ? `${fmtNumber(areaM2)} m²` : "N/A",
        },
        { k: "Maximum height", v: maxHeight },
        { k: "Minimum lot size", v: minLotSize },
        { k: "Minimum frontage", v: minFrontage },
      ]);

      // Overview map
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

      // Potential cautions list
      doc.moveDown(0.8);
      doc.fontSize(12).fillColor("#111111").text("Potential cautions");
      doc.moveDown(0.3);
      const overlayNames = (planning?.overlays || [])
        .map((o) => o?.name)
        .filter(Boolean);
      bulletList(
        doc,
        overlayNames.length
          ? overlayNames
          : ["No overlays identified from current mapping inputs."]
      );

      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Development potential
      // -------------------------
      drawTopBar(doc, {
        titleLeft: "Development Potential",
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

      // Gemini narrative (optional, but structured)
      const devSection = (narrative?.sections || []).find(
        (s) => s?.id === "development"
      );
      if (devSection) {
        sectionHeading(doc, safe(devSection.title || "Development guidance"));
        bulletList(doc, devSection.bullets || []);
        if (Array.isArray(devSection.notes) && devSection.notes.length) {
          doc.moveDown(0.6);
          doc.fontSize(10).fillColor("#333333");
          for (const n of devSection.notes) doc.text(safe(n));
        }
      } else {
        sectionHeading(doc, "Development guidance");
        doc
          .fontSize(10)
          .fillColor("#333333")
          .text(
            "Narrative guidance is not available yet. This section will be expanded once Gemini output is enabled for this endpoint."
          );
      }

      drawFooter(doc, { schemeVersion });
      doc.addPage();

      // -------------------------
      // Potential cautions (1 page per overlay)
      // -------------------------
      const cautions = planning?.overlays || [];
      if (cautions.length) {
        for (const o of cautions) {
          drawTopBar(doc, {
            titleLeft: "Potential Cautions",
            subtitleRight: safe(addressLabel),
          });

          sectionHeading(doc, safe(o?.name || "Overlay"));

          // Gemini caution matching (best-effort)
          const cautionItems =
            (narrative?.sections || []).find((s) => s?.id === "cautions")
              ?.items || [];
          const ci =
            cautionItems.find(
              (x) =>
                safe(x?.title).toLowerCase() === safe(o?.name).toLowerCase()
            ) ||
            cautionItems.find((x) =>
              safe(x?.title)
                .toLowerCase()
                .includes(safe(o?.name).toLowerCase().slice(0, 10))
            ) ||
            null;

          doc.fontSize(10).fillColor("#333333");
          if (ci?.summary) {
            doc.text(safe(ci.summary));
            if (Array.isArray(ci.implications) && ci.implications.length) {
              doc.moveDown(0.4);
              bulletList(doc, ci.implications, { fontSize: 10, indent: 12 });
            }
          } else {
            doc.text(
              "This overlay is mapped over or near the site. Review the applicable overlay code, mapping legend, and any assessment triggers for site-specific constraints."
            );
          }

          // Map: parcel + overlay highlight
          if (parcelGeo) {
            try {
              const overlayGeo = getOverlayGeometryByCode(planning, o.code);
              const mapBuf = await getParcelOverlayMapImageBufferV2({
                parcelGeoJSON: parcelGeo,
                overlayGeoJSON: overlayGeo,
                size: "640x360",
                maptype: process.env.STATIC_MAP_TYPE || "hybrid",
              });

              if (mapBuf) {
                doc.moveDown(0.7);
                doc
                  .fontSize(11)
                  .fillColor("#111111")
                  .text("Map view (overlay highlight)");
                doc.moveDown(0.4);
                doc.image(mapBuf, { fit: [500, 280], align: "center" });
              }
            } catch {}
          }

          drawFooter(doc, { schemeVersion });

          // Add a new page for next overlay unless this is the last section
          doc.addPage();
        }
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
