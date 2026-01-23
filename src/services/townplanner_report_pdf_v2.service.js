import PDFDocument from "pdfkit";
import {
  getParcelMapImageBufferV2,
  getParcelOverlayMapImageBufferV2,
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

  // Accept GeoJSON directly
  if (typeof maybe === "object" && maybe.type && maybe.coordinates)
    return maybe;

  // Accept { geometry: GeoJSON }
  if (
    typeof maybe === "object" &&
    maybe.geometry?.type &&
    maybe.geometry?.coordinates
  )
    return maybe.geometry;

  // Accept stringified GeoJSON / stringified wrapper
  const parsed = parseMaybeJson(maybe);
  if (parsed?.type && parsed?.coordinates) return parsed;
  if (parsed?.geometry?.type && parsed?.geometry?.coordinates)
    return parsed.geometry;

  return null;
}

function isPngBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) return false;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
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

function drawImageOrPlaceholder(doc, buf, box, label) {
  const { x, y, w, h } = box;

  if (isPngBuffer(buf)) {
    try {
      doc.image(buf, x, y, { fit: [w, h] });
      return;
    } catch {
      // fallthrough to placeholder
    }
  }

  // Placeholder (so page is never "blank")
  doc
    .save()
    .rect(x, y, w, h)
    .lineWidth(1)
    .strokeColor("#D1D5DB")
    .stroke()
    .fontSize(10)
    .fillColor("#6B7280")
    .text(
      label ||
        "Map image unavailable (Static Maps request failed or returned non-image data).",
      x + 12,
      y + 12,
      { width: w - 24 }
    )
    .restore();

  doc.fillColor("#000000");
}

function sectionTitle(doc, title) {
  doc.moveDown(0.8);
  doc.fontSize(16).fillColor("#111111").text(title);
  doc.moveDown(0.3);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .lineWidth(1)
    .strokeColor("#E5E7EB")
    .stroke();
  doc.moveDown(0.6);
  doc.fillColor("#000000");
}

function kvTable(doc, rows) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const col1 = 180;

  doc.fontSize(11);
  for (const r of rows) {
    doc.fillColor("#374151").text(safe(r.k), left, doc.y, { width: col1 });
    doc
      .fillColor("#111827")
      .text(safe(r.v), left + col1, doc.y, { width: width - col1 });
    doc.moveDown(0.4);
  }
  doc.fillColor("#000000");
}

function addFooter(doc, pageNumber) {
  const { left, right, bottom } = doc.page.margins;
  const y = doc.page.height - bottom + 10;

  doc
    .fontSize(9)
    .fillColor("#6B7280")
    .text(`Page ${pageNumber}`, left, y, {
      width: doc.page.width - left - right,
      align: "right",
    });

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

  // Prefer matching by code, then by name
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

  // If no match, return first geometry (better than blank)
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

      // ---------- Geo inputs (from planningData_v2 payload) ----------
      // Accept both v1-style and v2-style keys.
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

      // ---------- Cover ----------
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
        .text(`Planning scheme: ${schemeVersion}`, { align: "left" });

      addFooter(doc, pageNumber);
      doc.addPage();

      // ---------- Contents ----------
      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text(`Brisbane Town Planner • ${schemeVersion}`);
      doc.moveDown(0.6);
      doc.fontSize(16).fillColor("#111111").text("Contents");
      doc.moveDown(0.6);

      doc.fontSize(11).fillColor("#111827");
      const contents = [
        "Property snapshot",
        "Zoning (map)",
        "Development controls",
        ...overlays.map((o) => o?.name).filter(Boolean),
        "References & disclaimer",
      ].slice(0, 12);

      contents.forEach((t, idx) => {
        doc.text(`${idx + 1}. ${t}`);
      });

      doc.moveDown(0.8);
      doc
        .fontSize(9)
        .fillColor("#6B7280")
        .text(
          "Maps are indicative only. For authoritative mapping and rules, refer to Brisbane City Plan 2014 and the City Plan mapping."
        );

      addFooter(doc, pageNumber);
      doc.addPage();

      // ---------- Property snapshot ----------
      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text(`Brisbane Town Planner • ${schemeVersion}`);
      doc.moveDown(0.6);
      sectionTitle(doc, "Property snapshot");

      const merged = controls?.mergedControls || {};
      kvTable(doc, [
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
      ]);

      // Parcel map (outline)
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
          console.warn("[PDF v2] parcel map failed:", e?.message || e);
        }
      }

      drawImageOrPlaceholder(
        doc,
        parcelMapBuf,
        {
          x: doc.page.margins.left,
          y: doc.y + 18,
          w: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          h: 260,
        },
        "Parcel map unavailable."
      );

      doc.moveDown(18);
      addFooter(doc, pageNumber);
      doc.addPage();

      // ---------- Zoning (map) ----------
      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text(`Brisbane Town Planner • ${schemeVersion}`);
      doc.moveDown(0.6);
      sectionTitle(doc, "Zoning (map)");

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
          `Mapped zoning: ${safe(planning?.zoningCode ? `${planning.zoningCode} - ${planning?.zoningName || ""}` : planning?.zoningName || "Unknown")}`
        );

      let zoningMapBuf = null;
      if (parcelGeo && zoningGeo) {
        try {
          zoningMapBuf = await getParcelOverlayMapImageBufferV2({
            parcelGeoJSON: parcelGeo,
            overlayGeoJSON: zoningGeo,
            size: "640x360",
            maptype: "hybrid",
            scale: 2,
          });
        } catch (e) {
          console.warn("[PDF v2] zoning map failed:", e?.message || e);
        }
      }

      drawImageOrPlaceholder(
        doc,
        zoningMapBuf,
        {
          x: doc.page.margins.left,
          y: doc.y + 18,
          w: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          h: 300,
        },
        "Zoning map unavailable."
      );

      doc.moveDown(20);
      addFooter(doc, pageNumber);
      doc.addPage();

      // ---------- Development controls ----------
      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text(`Brisbane Town Planner • ${schemeVersion}`);
      doc.moveDown(0.6);
      sectionTitle(doc, "Development controls");

      kvTable(doc, [
        { k: "Maximum height", v: merged.max_height || "N/A" },
        { k: "Minimum lot size", v: merged.min_lot_size || "N/A" },
        { k: "Minimum frontage", v: merged.min_frontage || "N/A" },
        { k: "Maximum site coverage", v: merged.site_cover || "N/A" },
        { k: "Plot ratio / GFA", v: merged.plot_ratio || "N/A" },
        { k: "Density (if applicable)", v: merged.density || "N/A" },
      ]);

      const devSection = (narrative?.sections || []).find(
        (s) => s.id === "development"
      );
      if (devSection) {
        doc.moveDown(0.6);
        doc
          .fontSize(12)
          .fillColor("#111111")
          .text(devSection.title || "Development potential");
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor("#374151");
        (devSection.bullets || []).forEach((b) => doc.text(`• ${b}`));
        doc.moveDown(0.4);
        (devSection.notes || []).forEach((n) => doc.text(n));
      }

      doc.fillColor("#000000");
      addFooter(doc, pageNumber);

      // ---------- Overlay pages (one per overlay) ----------
      if (overlays.length) {
        for (const o of overlays) {
          doc.addPage();
          doc
            .fontSize(10)
            .fillColor("#6B7280")
            .text(`Brisbane Town Planner • ${schemeVersion}`);
          doc.moveDown(0.6);
          sectionTitle(doc, "Potential cautions");

          doc
            .fontSize(13)
            .fillColor("#111111")
            .text(safe(o?.name || "Overlay"));
          doc.moveDown(0.4);

          // narrative match (best-effort)
          const cautionItem = (narrative?.sections || [])
            .find((s) => s.id === "cautions")
            ?.items?.find((i) =>
              safe(i?.title)
                .toLowerCase()
                .includes(safe(o?.name).toLowerCase().slice(0, 12))
            );

          doc.fontSize(10).fillColor("#374151");
          if (cautionItem?.summary) {
            doc.text(cautionItem.summary);
            doc.moveDown(0.4);
            (cautionItem.implications || []).forEach((x) => doc.text(`• ${x}`));
          } else {
            doc.text(
              "This overlay is mapped over or near the site. Review the applicable overlay code and mapping for constraints and assessment triggers."
            );
          }

          // overlay map
          let overlayMapBuf = null;
          const overlayGeo = findOverlayGeometry(planning, o);

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
                "[PDF v2] overlay map failed:",
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
              y: doc.y + 18,
              w:
                doc.page.width - doc.page.margins.left - doc.page.margins.right,
              h: 300,
            },
            `Map unavailable for: ${safe(o?.name)}`
          );

          doc.moveDown(20);
          addFooter(doc, pageNumber);
        }
      }

      // ---------- References & disclaimer ----------
      doc.addPage();
      doc
        .fontSize(10)
        .fillColor("#6B7280")
        .text(`Brisbane Town Planner • ${schemeVersion}`);
      doc.moveDown(0.6);
      sectionTitle(doc, "References & disclaimer");

      const refSection = (narrative?.sections || []).find(
        (s) => s.id === "references"
      );
      doc.fontSize(10).fillColor("#374151");
      doc.text("References:");
      doc.moveDown(0.3);
      (refSection?.items || [schemeVersion]).forEach((r) => doc.text(`• ${r}`));

      doc.moveDown(0.8);
      doc.text(
        narrative?.disclaimer ||
          "This report is general information only and does not constitute legal advice."
      );

      doc.fillColor("#000000");
      addFooter(doc, pageNumber);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
