// src/services/townplanner_report_pdf_v2.service.js
//
// V2 PDF generator (reference-style upgrade)
// - Cover + Contents
// - Snapshot + Zoning map page + Controls page
// - One overlay page per overlay (with map highlight)
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

function parseMaybeJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function extractGeoJSON(maybe) {
  if (!maybe) return null;

  // GeoJSON geometry directly
  if (typeof maybe === "object" && maybe.type && maybe.coordinates)
    return maybe;

  // wrapper: { geometry: ... }
  if (
    typeof maybe === "object" &&
    maybe.geometry?.type &&
    maybe.geometry?.coordinates
  ) {
    return maybe.geometry;
  }

  // stringified
  const parsed = parseMaybeJson(maybe);
  if (parsed?.type && parsed?.coordinates) return parsed;
  if (parsed?.geometry?.type && parsed?.geometry?.coordinates)
    return parsed.geometry;

  return null;
}

function isPng(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) return false;
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

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

function drawFooter(doc, { brand, schemeVersion, pageNumber } = {}) {
  const { left, right, bottom } = doc.page.margins;
  const y = doc.page.height - bottom + 8;
  const w = doc.page.width - left - right;

  doc.save();
  doc.fontSize(8).fillColor("#666666");
  doc.text(`${brand} • ${schemeVersion}`.trim(), left, y, { width: w });
  doc.text(`Page ${pageNumber}`, left, y, { width: w, align: "right" });
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

function drawImageOrPlaceholder(doc, buf, { x, y, w, h }, label) {
  if (isPng(buf)) {
    try {
      doc.image(buf, x, y, { fit: [w, h] });
      return;
    } catch (e) {
      console.warn("[pdf_v2] doc.image failed:", e?.message || e);
    }
  }

  // Always draw something so the page is not blank
  doc.save();
  doc.rect(x, y, w, h).lineWidth(1).strokeColor("#D1D5DB").stroke();
  doc
    .fontSize(10)
    .fillColor("#6B7280")
    .text(
      label ||
        "Map image unavailable (Static Maps request failed). Check key restrictions or enable STATIC_MAPS_DEBUG=1.",
      x + 12,
      y + 12,
      { width: w - 24 }
    );
  doc.restore();
  doc.fillColor("#000000");
}

function findOverlayGeometry(planning, overlayMeta) {
  const polys = Array.isArray(planning?.overlayPolygons)
    ? planning.overlayPolygons
    : [];
  if (!polys.length) return null;

  const targetCode = safe(overlayMeta?.code || "")
    .trim()
    .toLowerCase();
  const targetName = safe(overlayMeta?.name || "")
    .trim()
    .toLowerCase();

  const byCode =
    targetCode &&
    polys.find((p) => safe(p?.code).trim().toLowerCase() === targetCode);

  if (byCode)
    return extractGeoJSON(byCode?.geometry || byCode?.polygon || byCode);

  const byName =
    targetName &&
    polys.find((p) => safe(p?.name).trim().toLowerCase() === targetName);

  if (byName)
    return extractGeoJSON(byName?.geometry || byName?.polygon || byName);

  return extractGeoJSON(polys[0]?.geometry || polys[0]?.polygon || polys[0]);
}

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
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      const chunks = [];

      let pageNumber = 1;
      doc.on("pageAdded", () => {
        pageNumber += 1;
      });

      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const BRAND = "Brisbane Town Planner";

      const parcelGeo =
        extractGeoJSON(planning?.siteParcelPolygon) ||
        extractGeoJSON(planning?.propertyParcel?.geojson) ||
        extractGeoJSON(planning?.parcelGeoJSON) ||
        extractGeoJSON(planning?.parcel);

      const zoningGeo =
        extractGeoJSON(planning?.zoningPolygon) ||
        extractGeoJSON(planning?.zoningGeoJSON) ||
        extractGeoJSON(planning?.zoning);

      const overlays = Array.isArray(planning?.overlays)
        ? planning.overlays
        : [];
      const merged = controls?.mergedControls || {};

      // ---------------- Cover ----------------
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, doc.page.margins.left, 40, { width: 140 });
        } catch {}
      }

      doc.moveDown(4);
      doc
        .fontSize(26)
        .fillColor("#111111")
        .text("Property Report", { align: "left" });
      doc.moveDown(0.8);
      doc
        .fontSize(14)
        .fillColor("#374151")
        .text(safe(addressLabel), { align: "left" });
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text(`Report generated ${new Date().toLocaleDateString("en-AU")}`, {
          align: "left",
        });
      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text(`Planning scheme: ${schemeVersion}`, {
          align: "left",
        });

      drawFooter(doc, { brand: BRAND, schemeVersion, pageNumber });

      doc.addPage();

      // ---------------- Contents ----------------
      drawTopBar(doc, { titleLeft: BRAND, subtitleRight: schemeVersion });
      doc.fontSize(16).fillColor("#111111").text("Contents");
      doc.moveDown(0.6);

      const contents = [
        "Property snapshot",
        "Zoning (map)",
        "Development controls",
        ...overlays.map((o) => o?.name).filter(Boolean),
        "References & disclaimer",
      ].slice(0, 15);

      doc.fontSize(11).fillColor("#111827");
      contents.forEach((t, idx) => doc.text(`${idx + 1}. ${t}`));

      doc.moveDown(0.8);
      doc
        .fontSize(9)
        .fillColor("#6B7280")
        .text(
          "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping."
        );

      drawFooter(doc, { brand: BRAND, schemeVersion, pageNumber });
      doc.addPage();

      // ---------------- Property snapshot ----------------
      drawTopBar(doc, { titleLeft: BRAND, subtitleRight: schemeVersion });
      sectionHeading(doc, "Property snapshot");

      keyValueGrid(doc, [
        { k: "Address", v: safe(addressLabel) },
        {
          k: "Zoning",
          v: safe(
            planning?.zoningCode
              ? `${planning.zoningCode} - ${planning?.zoningName || ""}`
              : planning?.zoningName || "Unknown"
          ),
        },
        {
          k: "Neighbourhood plan",
          v: safe(planning?.neighbourhoodPlan || "Not mapped"),
        },
        {
          k: "Precinct",
          v: safe(planning?.neighbourhoodPlanPrecinctCode || "Not mapped"),
        },
        {
          k: "Site area (approx.)",
          v: merged?.site_area_m2
            ? `${merged.site_area_m2} m²`
            : planning?.propertyParcel?.debug?.areaM2
              ? `${Math.round(planning.propertyParcel.debug.areaM2)} m²`
              : "N/A",
        },
        { k: "Max height", v: safe(merged?.max_height || "N/A") },
      ]);

      let parcelMapBuf = null;
      if (parcelGeo) {
        try {
          parcelMapBuf = await getParcelMapImageBufferV2({
            parcelGeoJSON: parcelGeo,
            size: "640x360",
            maptype: "hybrid",
            scale: 2,
          });
        } catch (e) {
          console.warn("[pdf_v2] parcel map failed:", e?.message || e);
        }
      }

      drawImageOrPlaceholder(
        doc,
        parcelMapBuf,
        {
          x: doc.page.margins.left,
          y: doc.y + 10,
          w: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          h: 280,
        },
        "Parcel map unavailable."
      );

      drawFooter(doc, { brand: BRAND, schemeVersion, pageNumber });
      doc.addPage();

      // ---------------- Zoning (map) ----------------
      drawTopBar(doc, { titleLeft: BRAND, subtitleRight: schemeVersion });
      sectionHeading(doc, "Zoning (map)");

      doc
        .fontSize(10)
        .fillColor("#374151")
        .text(
          "This page highlights the mapped zoning for the subject site. Confirm boundaries and zone intent against Brisbane City Plan 2014 mapping."
        );
      doc.moveDown(0.4);
      doc
        .fontSize(10)
        .fillColor("#111827")
        .text(
          `Mapped zoning: ${safe(
            planning?.zoningCode
              ? `${planning.zoningCode} - ${planning?.zoningName || ""}`
              : planning?.zoningName || "Unknown"
          )}`
        );

      let zoningMapBuf = null;
      if (parcelGeo && zoningGeo) {
        try {
          zoningMapBuf = await getParcelZoningMapImageBufferV2({
            parcelGeoJSON: parcelGeo,
            overlayGeoJSON: zoningGeo,
            size: "640x360",
            maptype: "hybrid",
            scale: 2,
          });
        } catch (e) {
          console.warn("[pdf_v2] zoning map failed:", e?.message || e);
        }
      }

      drawImageOrPlaceholder(
        doc,
        zoningMapBuf,
        {
          x: doc.page.margins.left,
          y: doc.y + 12,
          w: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          h: 300,
        },
        "Zoning map unavailable."
      );

      drawFooter(doc, { brand: BRAND, schemeVersion, pageNumber });
      doc.addPage();

      // ---------------- Development controls ----------------
      drawTopBar(doc, { titleLeft: BRAND, subtitleRight: schemeVersion });
      sectionHeading(doc, "Development controls");

      keyValueGrid(doc, [
        { k: "Maximum height", v: safe(merged.max_height || "N/A") },
        { k: "Minimum lot size", v: safe(merged.min_lot_size || "N/A") },
        { k: "Minimum frontage", v: safe(merged.min_frontage || "N/A") },
        { k: "Maximum site coverage", v: safe(merged.site_cover || "N/A") },
        { k: "Plot ratio / GFA", v: safe(merged.plot_ratio || "N/A") },
        { k: "Density", v: safe(merged.density || "N/A") },
      ]);

      const devSection = (narrative?.sections || []).find(
        (s) => s.id === "development"
      );
      if (devSection) {
        doc.moveDown(0.2);
        doc
          .fontSize(12)
          .fillColor("#111111")
          .text(devSection.title || "Development potential");
        doc.moveDown(0.4);
        bulletList(doc, devSection.bullets || []);
      }

      drawFooter(doc, { brand: BRAND, schemeVersion, pageNumber });

      // ---------------- Overlay pages ----------------
      for (const o of overlays) {
        doc.addPage();
        drawTopBar(doc, { titleLeft: BRAND, subtitleRight: schemeVersion });
        sectionHeading(doc, "Potential cautions");

        doc
          .fontSize(13)
          .fillColor("#111111")
          .text(safe(o?.name || "Overlay"));
        doc.moveDown(0.4);

        const cautionItem = (narrative?.sections || [])
          .find((s) => s.id === "cautions")
          ?.items?.find((i) =>
            (i.title || "")
              .toLowerCase()
              .includes((o?.name || "").toLowerCase().slice(0, 12))
          );

        doc.fontSize(10).fillColor("#333333");
        if (cautionItem?.summary) {
          doc.text(cautionItem.summary);
          doc.moveDown(0.4);
          (cautionItem.implications || []).forEach((x) => doc.text(`• ${x}`));
        } else {
          doc.text(
            "This overlay is mapped over or near the site. Review the applicable overlay code and mapping for constraints and assessment triggers."
          );
        }

        const overlayGeo = findOverlayGeometry(planning, o);

        let overlayMapBuf = null;
        if (parcelGeo && overlayGeo) {
          try {
            overlayMapBuf = await getParcelOverlayMapImageBufferV2({
              parcelGeoJSON: parcelGeo,
              overlayGeoJSON: overlayGeo,
              size: "640x360",
              maptype: "hybrid",
              scale: 2,
            });
          } catch (e) {
            console.warn(
              "[pdf_v2] overlay map failed:",
              o?.name,
              e?.message || e
            );
          }
        }

        drawImageOrPlaceholder(
          doc,
          overlayMapBuf,
          {
            x: doc.page.margins.left,
            y: doc.y + 12,
            w: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            h: 300,
          },
          `Map unavailable for: ${safe(o?.name)}`
        );

        drawFooter(doc, { brand: BRAND, schemeVersion, pageNumber });
      }

      // ---------------- References & disclaimer ----------------
      doc.addPage();
      drawTopBar(doc, { titleLeft: BRAND, subtitleRight: schemeVersion });
      sectionHeading(doc, "References & disclaimer");

      const refSection = (narrative?.sections || []).find(
        (s) => s.id === "references"
      );
      doc.fontSize(10).fillColor("#333333");
      doc.text("References:");
      doc.moveDown(0.3);
      (refSection?.items || [schemeVersion]).forEach((r) => doc.text(`• ${r}`));
      doc.moveDown(0.8);
      doc.text(
        narrative?.disclaimer ||
          "This report is general information only and does not constitute legal advice."
      );

      drawFooter(doc, { brand: BRAND, schemeVersion, pageNumber });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
