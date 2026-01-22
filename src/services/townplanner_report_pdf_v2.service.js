import PDFDocument from "pdfkit";
import axios from "axios";

function safe(obj) {
  return obj == null ? "" : String(obj);
}

function addFooter(doc) {
  const { left, right, bottom } = doc.page.margins;
  const y = doc.page.height - bottom + 10;
  doc.fontSize(9).fillColor("#666666");
  doc.text(`Page ${doc.page.pageNumber}`, left, y, {
    width: doc.page.width - left - right,
    align: "right",
  });
  doc.fillColor("#000000");
}

function sectionTitle(doc, title) {
  doc.moveDown(0.8);
  doc.fontSize(16).fillColor("#111111").text(title, { continued: false });
  doc.moveDown(0.3);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .lineWidth(1)
    .strokeColor("#E0E0E0")
    .stroke();
  doc.moveDown(0.6);
}

function kvTable(doc, rows) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const col1 = 180;

  doc.fontSize(11);
  for (const r of rows) {
    doc.fillColor("#444444").text(safe(r.k), left, doc.y, { width: col1 });
    doc
      .fillColor("#111111")
      .text(safe(r.v), left + col1, doc.y, { width: width - col1 });
    doc.moveDown(0.4);
  }
  doc.fillColor("#000000");
}

async function maybeFetchImage(url) {
  if (!url) return null;
  try {
    const resp = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(resp.data);
  } catch {
    return null;
  }
}

// Optional: if you want map images later, wire Google Static Maps here.
// For now, leave as null and we’ll add once you confirm your API key + quota approach.
async function getMapImageBufferV2() {
  return null;
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
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Cover
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, doc.page.margins.left, 40, { width: 140 });
      } catch {}
    }

    doc.moveDown(4);
    doc
      .fontSize(26)
      .fillColor("#111111")
      .text("Property Lot Report", { align: "left" });
    doc.moveDown(0.8);
    doc
      .fontSize(14)
      .fillColor("#333333")
      .text(safe(addressLabel), { align: "left" });
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .fillColor("#666666")
      .text(`Scheme: ${schemeVersion}`, { align: "left" });
    doc
      .fontSize(10)
      .fillColor("#666666")
      .text(`Generated: ${new Date().toLocaleDateString("en-AU")}`, {
        align: "left",
      });

    addFooter(doc);
    doc.addPage();

    // Property overview
    sectionTitle(doc, "Property overview");

    const parcelArea = planning?.propertyParcel?.debug?.areaM2;
    const zoning = planning?.zoning;
    const np = planning?.neighbourhoodPlan;
    const precinct = planning?.neighbourhoodPlanPrecinct;

    kvTable(doc, [
      { k: "Zoning", v: zoning || "Unknown" },
      { k: "Neighbourhood plan", v: np || "Not mapped" },
      { k: "Precinct", v: precinct || "Not mapped" },
      {
        k: "Site area (approx.)",
        v: parcelArea ? `${Math.round(parcelArea)} m²` : "Not available",
      },
      { k: "Overlays detected", v: planning?.overlays?.length || 0 },
    ]);

    doc.moveDown(0.8);
    doc
      .fontSize(12)
      .fillColor("#111111")
      .text("Key cautions (from mapping)", { underline: false });
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor("#333333");
    (planning?.overlays || [])
      .slice(0, 8)
      .forEach((o) => doc.text(`• ${o.name}`));
    doc.fillColor("#000000");

    addFooter(doc);
    doc.addPage();

    // Development potential (controls + Gemini narrative)
    sectionTitle(doc, "Development potential");

    const merged = controls?.mergedControls || {};
    kvTable(doc, [
      {
        k: "Max height",
        v: merged.max_height || "Not available from provided controls",
      },
      {
        k: "Min lot size",
        v: merged.min_lot_size || "Not available from provided controls",
      },
      {
        k: "Min frontage",
        v: merged.min_frontage || "Not available from provided controls",
      },
      {
        k: "Site cover",
        v: merged.site_cover || "Not available from provided controls",
      },
      {
        k: "Plot ratio / GFA",
        v: merged.plot_ratio || "Not available from provided controls",
      },
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
      doc.fontSize(10).fillColor("#333333");
      (devSection.bullets || []).forEach((b) => doc.text(`• ${b}`));
      doc.moveDown(0.4);
      (devSection.notes || []).forEach((n) => doc.text(n));
      doc.fillColor("#000000");
    }

    addFooter(doc);

    // Cautions pages (one page per overlay for strong visual structure)
    const cautions = planning?.overlays || [];
    if (cautions.length) {
      for (const o of cautions) {
        doc.addPage();
        sectionTitle(doc, "Potential cautions");
        doc.fontSize(13).fillColor("#111111").text(o.name);
        doc.moveDown(0.4);

        const cautionItem = (narrative?.sections || [])
          .find((s) => s.id === "cautions")
          ?.items?.find((i) =>
            (i.title || "")
              .toLowerCase()
              .includes((o.name || "").toLowerCase().slice(0, 12))
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

        // Placeholder for map image (we’ll wire Google Static Maps next)
        const mapBuf = await getMapImageBufferV2();
        if (mapBuf) {
          try {
            doc.moveDown(0.7);
            doc.image(mapBuf, { fit: [500, 280], align: "center" });
          } catch {}
        }

        addFooter(doc);
      }
    }

    // References + Disclaimer
    doc.addPage();
    sectionTitle(doc, "References and disclaimer");

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
    doc.fillColor("#000000");

    addFooter(doc);

    doc.end();
  });
}
