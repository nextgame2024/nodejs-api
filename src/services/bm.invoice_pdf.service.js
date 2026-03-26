import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRAND = {
  teal: "#0F2B2B",
  teal2: "#143838",
  text: "#111111",
  muted: "#5A5F66",
  mutedLight: "#7A8088",
  border: "#E2E6E9",
  white: "#FFFFFF",
  totalBar: "#1E1E1E",
};

const PAGE = {
  size: "A4",
  margin: 56,
};

const LOGO_URL =
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/sophiaAi-logo.png";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BELINDA_FONT_CANDIDATES = [
  process.env.PDF_BELINDA_FONT_PATH || "",
  path.resolve(__dirname, "../assets/fonts/Belinda.ttf"),
  path.resolve(__dirname, "../assets/fonts/Belinda.otf"),
  path.resolve(__dirname, "../assets/fonts/Belinda-Regular.ttf"),
  "/Library/Fonts/Belinda.ttf",
  "/Library/Fonts/Belinda.otf",
  "/Library/Fonts/Belinda Regular.ttf",
  "/Users/josecorredor/Library/Fonts/Belinda.ttf",
  "/Users/josecorredor/Library/Fonts/Belinda Regular.ttf",
];
const BELINDA_FONT_PATH = BELINDA_FONT_CANDIDATES.find(
  (p) => p && fs.existsSync(p),
);

function formatDateAU(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function formatMoney(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

function contentW(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}
function X(doc) {
  return doc.page.margins.left;
}
function Y(doc) {
  return doc.page.margins.top;
}

function clean(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function companyDisplayName(company) {
  return (
    clean(company?.legalName) ||
    clean(company?.tradingName) ||
    clean(company?.companyName) ||
    "Company"
  );
}

function topBarInfoLines(company) {
  return [
    companyDisplayName(company),
    clean(company?.country) || "Australia",
    clean(company?.email),
    clean(company?.website),
    clean(company?.abn) ? `ABN: ${clean(company?.abn)}` : null,
  ].filter(Boolean);
}

async function fetchBuffer(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } catch {
    return null;
  }
}

function registerBelindaFont(doc) {
  if (!BELINDA_FONT_PATH) return false;
  try {
    doc.registerFont("Belinda", BELINDA_FONT_PATH);
    return true;
  } catch {
    return false;
  }
}

function drawHeader(doc, { title, logoBuffer, company }) {
  const x = X(doc);
  const y = Y(doc);
  const w = contentW(doc);
  const barH = 70;
  const barY = y - 6;
  const logoSize = 56;
  const logoGap = 14;
  const companyName = companyDisplayName(company);
  const topBarLines = topBarInfoLines(company);

  doc.save();
  doc.roundedRect(x, barY, w, barH, 14);
  doc.fillColor(BRAND.teal).fill();
  doc.restore();

  const logoX = x + 12;
  const logoY = barY + Math.round((barH - logoSize) / 2);
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, logoX, logoY, {
        fit: [logoSize, logoSize],
        align: "center",
        valign: "center",
      });
    } catch {
      doc
        .fillColor(BRAND.white)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(companyName || "Company", logoX, y + 12);
    }
  } else {
    doc
      .fillColor(BRAND.white)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(companyName || "Company", logoX, y + 12);
  }

  const titleW = 160;
  const infoX = logoX + logoSize + logoGap;
  const infoW = Math.max(120, w - (infoX - x) - titleW - 14);
  doc
    .fillColor(BRAND.white)
    .font("Helvetica")
    .fontSize(8.5)
    .text(topBarLines.join("\n"), infoX, y + 4, {
      width: infoW,
      lineGap: 0.8,
      height: barH - 8,
      ellipsis: true,
    });

  doc
    .fillColor(BRAND.white)
    .font("Helvetica-Bold")
    .fontSize(18)
    .text(title, x + w - titleW - 10, y + 23, {
      width: titleW,
      align: "right",
    });

  doc.y = y + barH + 8;
}

function ensureSpace(doc, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) {
    doc.addPage();
    doc.y = Y(doc);
  }
}

function drawTable(doc, title, columns, rows) {
  const x = X(doc);
  const w = contentW(doc);

  ensureSpace(doc, 32);
  doc
    .fillColor(BRAND.teal2)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(title, x, doc.y);
  doc.moveDown(0.6);

  const rowHeight = 18;
  const headerY = doc.y;
  const pad = 4;

  doc.fillColor(BRAND.white).rect(x, headerY, w, rowHeight).fill(BRAND.teal);

  let colX = x;
  doc.fillColor(BRAND.white).font("Helvetica-Bold").fontSize(9);
  columns.forEach((col) => {
    doc.text(col.label, colX + pad, headerY + 4, {
      width: col.width - pad * 2,
      align: col.align || "left",
    });
    colX += col.width;
  });

  doc.y = headerY + rowHeight;

  doc.font("Helvetica").fontSize(9).fillColor(BRAND.text);
  rows.forEach((row) => {
    ensureSpace(doc, rowHeight + 4);
    const rowY = doc.y;
    colX = x;
    columns.forEach((col) => {
      doc.text(row[col.key] ?? "", colX + pad, rowY + 4, {
        width: col.width - pad * 2,
        align: col.align || "left",
      });
      colX += col.width;
    });
    doc
      .strokeColor(BRAND.border)
      .lineWidth(0.5)
      .moveTo(x, rowY + rowHeight)
      .lineTo(x + w, rowY + rowHeight)
      .stroke();
    doc.y = rowY + rowHeight;
  });

  doc.moveDown(0.8);
}

function resolveLaborRows(laborTotal, laborLines, laborSummary) {
  const lines = laborLines || [];
  const summaryTotal = Number(laborSummary?.additionalTotal ?? 0);
  const documentTotal = Number(laborTotal ?? 0);
  const linesTotal = lines.reduce(
    (sum, line) => sum + Number(line?.lineTotal ?? 0),
    0,
  );
  const resolvedTotal =
    Number.isFinite(documentTotal) && documentTotal > 0
      ? documentTotal
      : Number.isFinite(summaryTotal) && summaryTotal > 0
        ? summaryTotal
        : Number.isFinite(linesTotal)
          ? linesTotal
          : 0;

  const hasLaborSummary = Number.isFinite(summaryTotal) && summaryTotal > 0;
  const hasLabor = lines.length > 0 || hasLaborSummary || resolvedTotal > 0;
  if (!hasLabor) return [];

  return [
    {
      description: "Labor cost",
      lineTotal: formatMoney(resolvedTotal),
    },
  ];
}

function drawDocumentIntro(
  doc,
  { document, company, client, project, logoBuffer },
) {
  ensureSpace(doc, 120);

  const x = X(doc);
  const y = doc.y;
  const w = contentW(doc);
  const leftW = Math.floor(w * 0.64);
  const rightX = x + leftW;
  const rightW = w - leftW;

  const issueDate = document.issueDate || new Date();
  const rightMeta = [
    `Invoice No. ${document.docNumber || document.documentId}`,
    formatDateAU(issueDate),
  ].filter(Boolean);
  if (project?.projectName) rightMeta.push(project.projectName);

  doc.fillColor(BRAND.muted).font("Helvetica").fontSize(11);
  doc.text(rightMeta.join("\n"), rightX, y + 6, {
    width: rightW,
    align: "right",
    lineGap: 2,
  });
  const rightBottom =
    y +
    doc.heightOfString(rightMeta.join("\n"), {
      width: rightW,
      align: "right",
      lineGap: 4,
    }) +
    6;

  const billedY = y + 2;
  const clientLines = [
    clean(client?.clientName),
    clean(client?.email),
    clean(client?.address),
    clean(client?.phone),
  ].filter(Boolean);

  doc
    .fillColor(BRAND.text)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("Billed to:", x, billedY);
  doc
    .fillColor(BRAND.text)
    .font("Helvetica")
    .fontSize(11)
    .text(clientLines.join("\n"), x, billedY + 25, {
      width: Math.floor(w * 0.72),
      lineGap: 2,
    });

  const billedHeight = doc.heightOfString(clientLines.join("\n"), {
    width: leftW - 10,
    lineGap: 2,
  });
  const leftBottom = billedY + 25 + billedHeight;
  doc.y = Math.max(leftBottom, rightBottom) + 14;
}

function drawScopeAndTotals(doc, { scopeText, totals }) {
  ensureSpace(doc, 210);
  const x = X(doc);
  const y = doc.y;
  const w = contentW(doc);
  const leftW = Math.floor(w * 0.58);
  const rightX = x + leftW + 14;
  const rightW = w - leftW - 14;

  const safeScope = clean(scopeText) || "";
  doc
    .fillColor(BRAND.mutedLight)
    .font("Helvetica")
    .fontSize(10)
    .text(safeScope, x, y, { width: leftW, lineGap: 3 });
  const leftHeight = doc.heightOfString(safeScope, {
    width: leftW,
    lineGap: 3,
  });

  let rowY = y + 4;
  const summaryRows = totals.filter(([label]) => label !== "Total");
  summaryRows.forEach(([label, value]) => {
    doc
      .fillColor(BRAND.text)
      .font("Helvetica")
      .fontSize(11)
      .text(label, rightX, rowY, {
        width: rightW * 0.55,
      });
    doc.font("Helvetica").text(value, rightX, rowY, {
      width: rightW,
      align: "right",
    });
    rowY += 20;
  });

  const totalRow = totals.find(([label]) => label === "Total");
  if (totalRow) {
    const totalBarY = rowY + 6;
    const totalBarH = 40;
    doc.save();
    doc.rect(rightX, totalBarY, rightW, totalBarH).fill(BRAND.totalBar);
    doc.restore();

    doc
      .fillColor(BRAND.white)
      .font("Helvetica-Bold")
      .fontSize(14)
      .text("Total", rightX + 14, totalBarY + 13, {
        width: rightW * 0.5,
      });
    const totalValue = String(totalRow[1] ?? "");
    const totalValueWithCurrency = totalValue.startsWith("$")
      ? totalValue
      : `$${totalValue}`;
    doc.fontSize(16).text(totalValueWithCurrency, rightX, totalBarY + 13, {
      width: rightW - 12,
      align: "right",
    });
    rowY = totalBarY + totalBarH;
  }

  doc.y = Math.max(y + leftHeight, rowY) + 16;
}

function drawFooter(doc, { company, logoBuffer, hasBelindaFont }) {
  ensureSpace(doc, 180);

  const x = X(doc);
  const y = doc.y;
  const w = contentW(doc);
  const leftW = Math.floor(w * 0.52);
  const rightX = x + leftW + 14;
  const rightW = w - leftW - 14;

  doc
    .fillColor(BRAND.text)
    .font(hasBelindaFont ? "Belinda" : "Times-Italic")
    .fontSize(28)
    .text("Thank you", x, y, {
      width: leftW,
    });
  doc
    .fillColor(BRAND.text)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("Payment Information", x, y + 56, {
      width: leftW,
    });

  const paymentLines = [
    clean(company?.bank),
    clean(company?.accountName)
      ? `Account Name: ${clean(company?.accountName)}`
      : null,
    clean(company?.bsbNumber)
      ? `BSB Number: ${clean(company?.bsbNumber)}`
      : null,
    clean(company?.accountNumber)
      ? `Account Number: ${clean(company?.accountNumber)}`
      : null,
  ].filter(Boolean);

  doc
    .fillColor(BRAND.text)
    .font("Helvetica")
    .fontSize(9)
    .text(
      paymentLines.length
        ? paymentLines.join("\n")
        : "Bank details available on request.",
      x,
      y + 88,
      { width: leftW, lineGap: 4 },
    );
  const leftHeight =
    88 +
    doc.heightOfString(
      paymentLines.length
        ? paymentLines.join("\n")
        : "Bank details available on request.",
      {
        width: leftW,
        lineGap: 4,
      },
    );

  let rightBottom = y;
  if (logoBuffer) {
    try {
      const logoW = Math.min(230, rightW - 16);
      const logoX = rightX + (rightW - logoW) / 2;
      doc.image(logoBuffer, logoX, y + 20, {
        fit: [logoW, 110],
        align: "center",
      });
      rightBottom = y + 132;
    } catch {
      rightBottom = y + 40;
    }
  }

  doc
    .fillColor(BRAND.text)
    .font("Helvetica")
    .fontSize(12)
    .text(
      clean(company?.address) || "",
      rightX,
      Math.max(rightBottom, y + 120),
      {
        width: rightW,
        align: "center",
      },
    );
  rightBottom =
    Math.max(rightBottom, y + 120) +
    doc.heightOfString(clean(company?.address) || "", {
      width: rightW,
      align: "center",
    });

  doc.y = Math.max(y + leftHeight, rightBottom) + 10;
}

export async function buildInvoicePdf({
  document,
  company,
  client,
  project,
  materialLines,
  laborLines,
  surchargeLines = [],
  laborSummary,
  surchargeTotal = 0,
}) {
  const doc = new PDFDocument({ size: PAGE.size, margins: PAGE.margin });
  const hasBelindaFont = registerBelindaFont(doc);

  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const logoUrl = company?.logoUrl || LOGO_URL;
  const logoBuffer =
    (await fetchBuffer(logoUrl)) ||
    (logoUrl !== LOGO_URL ? await fetchBuffer(LOGO_URL) : null);

  drawHeader(doc, {
    title: "Invoice",
    logoBuffer,
    company,
  });
  drawDocumentIntro(doc, { document, company, client, project, logoBuffer });

  const tableW = contentW(doc);
  const costInQuote = project?.costInQuote ?? true;

  if (!costInQuote && project?.description) {
    ensureSpace(doc, 36);
    doc
      .fillColor(BRAND.teal2)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("Description", X(doc), doc.y);
    doc
      .fillColor(BRAND.text)
      .font("Helvetica")
      .fontSize(9)
      .text(project.description, X(doc), doc.y + 14, {
        width: contentW(doc),
      });
    doc.moveDown(2.2);
  }

  const column1 = Math.floor(tableW * 0.42);
  const column2 = Math.floor(tableW * 0.12);
  const column3 = Math.floor(tableW * 0.18);
  const column4 = tableW - (column1 + column2 + column3);

  const materialsColumns = costInQuote
    ? [
        { key: "description", label: "Description", width: column1 },
        { key: "quantity", label: "Qty", width: column2, align: "right" },
        { key: "unitPrice", label: "Unit", width: column3, align: "right" },
        { key: "lineTotal", label: "Total", width: column4, align: "right" },
      ]
    : [
        { key: "description", label: "Description", width: tableW * 0.7 },
        { key: "quantity", label: "Qty", width: tableW * 0.3, align: "right" },
      ];
  const compactColumns = [
    {
      key: "description",
      label: "Description",
      width: Math.floor(tableW * 0.7),
    },
    {
      key: "lineTotal",
      label: "Total",
      width: Math.ceil(tableW * 0.3),
      align: "right",
    },
  ];

  const materialRows = (materialLines || []).map((line) => ({
    description: line.materialName || line.description || "Material",
    quantity: formatMoney(line.quantity ?? 0),
    unitPrice: formatMoney(line.unitPrice ?? 0),
    lineTotal: formatMoney(line.lineTotal ?? 0),
  }));
  const displayLaborRows = resolveLaborRows(
    document?.laborTotal,
    laborLines,
    laborSummary,
  );
  const displaySurchargeRows = (surchargeLines || []).map((line) => ({
    description: line.name || "Other concept",
    lineTotal: formatMoney(line.cost ?? 0),
  }));

  let renderedCostTable = false;
  if (costInQuote) {
    if (materialRows.length > 0) {
      drawTable(doc, "Materials", materialsColumns, materialRows);
      renderedCostTable = true;
    }

    if (displayLaborRows.length > 0) {
      drawTable(doc, "Labor", compactColumns, displayLaborRows);
      renderedCostTable = true;
    }

    if (displaySurchargeRows.length > 0) {
      drawTable(doc, "Other concepts ", compactColumns, displaySurchargeRows);
      renderedCostTable = true;
    }

    if (renderedCostTable) {
      doc.moveDown(0.3);
    }
  }

  const subtotal = Number(document.subtotal ?? 0);
  const gst = Number(document.gst ?? 0);
  const total = Number(document.totalAmount ?? subtotal + gst);
  const gstRate = subtotal > 0 ? (gst / subtotal) * 100 : 0;

  const materialTotalValue = Number(document.materialTotal ?? 0);
  const laborTotalValue = Number(document.laborTotal ?? 0);
  const surchargeTotalValue = Number(surchargeTotal ?? 0);
  const showMaterialTotals = materialRows.length > 0 || materialTotalValue > 0;
  const showLaborTotals = displayLaborRows.length > 0 || laborTotalValue > 0;
  const showSurchargeTotals =
    displaySurchargeRows.length > 0 || surchargeTotalValue > 0;

  const totals = [];
  if (costInQuote) {
    if (showMaterialTotals)
      totals.push(["Materials", formatMoney(materialTotalValue)]);
    if (showLaborTotals)
      totals.push(["Labor Cost", formatMoney(laborTotalValue)]);
    if (showSurchargeTotals)
      totals.push(["Other concepts ", formatMoney(surchargeTotalValue)]);
  }
  totals.push(["Subtotal", formatMoney(subtotal)]);
  totals.push([`GST (${gstRate.toFixed(2)}%)`, formatMoney(gst)]);
  totals.push(["Total", formatMoney(total)]);

  drawScopeAndTotals(doc, {
    scopeText: project?.scopeAndConditions,
    totals,
  });

  drawFooter(doc, { company, logoBuffer, hasBelindaFont });

  doc.end();

  return await new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
