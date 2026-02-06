import PDFDocument from "pdfkit";

const BRAND = {
  teal: "#0F2B2B",
  teal2: "#143838",
  text: "#111111",
  muted: "#5A5F66",
  light: "#F5F7F8",
  border: "#E2E6E9",
  white: "#FFFFFF",
};

const PAGE = {
  size: "A4",
  margin: 56,
};

const LOGO_URL =
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/sophiaAi-logo.png";

const TERMS = {
  validityDays: 14,
  paymentTerms:
    "Payment due within 7 days of invoice date after acceptance of this quote.",
};

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

function drawHeader(doc, { title, logoBuffer }) {
  const x = X(doc);
  const y = Y(doc);
  const w = contentW(doc);

  doc.save();
  doc.roundedRect(x, y - 6, w, 44, 14);
  doc.fillColor(BRAND.teal).fill();
  doc.restore();

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, x + 14, y + 4, { height: 24 });
    } catch {
      doc
        .fillColor(BRAND.white)
        .font("Helvetica-Bold")
        .fontSize(13)
        .text("sophiaAi", x + 14, y + 10);
    }
  } else {
    doc
      .fillColor(BRAND.white)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("sophiaAi", x + 14, y + 10);
  }

  doc
    .fillColor(BRAND.white)
    .font("Helvetica-Bold")
    .fontSize(16)
    .text(title, x, y + 4, { width: w - 20, align: "right" });

  doc.moveDown(2);
}

function ensureSpace(doc, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) {
    doc.addPage();
    doc.y = Y(doc);
  }
}

function drawInfoBlock(doc, title, lines, x, y, w) {
  doc
    .fillColor(BRAND.teal2)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(title, x, y);

  doc
    .fillColor(BRAND.text)
    .font("Helvetica")
    .fontSize(9)
    .text(lines.filter(Boolean).join("\n"), x, y + 14, {
      width: w,
    });
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

export async function buildQuotePdf({
  document,
  company,
  client,
  project,
  materialLines,
  laborLines,
}) {
  const doc = new PDFDocument({ size: PAGE.size, margins: PAGE.margin });

  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const logoBuffer = await fetchBuffer(LOGO_URL);
  drawHeader(doc, { title: "Quote", logoBuffer });

  const leftX = X(doc);
  const rightX = X(doc) + contentW(doc) / 2 + 10;
  const colW = contentW(doc) / 2 - 10;

  const companyLines = [
    company.legalName || company.tradingName || "Company",
    company.tradingName ? `Trading as ${company.tradingName}` : null,
    company.abn ? `ABN: ${company.abn}` : null,
    company.address,
    company.email,
    company.phone,
  ];

  const clientLines = [
    client.clientName,
    client.address,
    client.email,
    client.phone,
  ];

  const infoY = doc.y;
  drawInfoBlock(doc, "From", companyLines, leftX, infoY, colW);
  drawInfoBlock(doc, "To", clientLines, rightX, infoY, colW);

  const fromHeight =
    14 +
    doc.heightOfString(companyLines.filter(Boolean).join("\n"), {
      width: colW,
    });
  const toHeight =
    14 +
    doc.heightOfString(clientLines.filter(Boolean).join("\n"), {
      width: colW,
    });
  doc.y = infoY + Math.max(fromHeight, toHeight) + 18;

  const issueDate = document.issueDate || new Date();
  const validUntil = new Date(issueDate);
  validUntil.setDate(validUntil.getDate() + TERMS.validityDays);

  const metaLines = [
    `Quote # ${document.docNumber || document.documentId}`,
    `Issue date: ${formatDateAU(issueDate)}`,
    `Valid until: ${formatDateAU(validUntil)}`,
    project?.projectName ? `Project: ${project.projectName}` : null,
  ];

  doc
    .fillColor(BRAND.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(metaLines.filter(Boolean).join("  •  "), X(doc), doc.y);

  doc.moveDown(1.2);

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
  const column4 = tableW - (c1 + c2 + c3);

  const columns = costInQuote
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

  if (costInQuote) {
    drawTable(
      doc,
      "Materials",
      columns,
      (materialLines || []).map((line) => ({
        description: line.materialName || line.description || "Material",
        quantity: formatMoney(line.quantity ?? 0),
        unitPrice: formatMoney(line.unitPrice ?? 0),
        lineTotal: formatMoney(line.lineTotal ?? 0),
      })),
    );

    drawTable(
      doc,
      "Labor",
      columns,
      (laborLines || []).map((line) => ({
        description: line.laborName || line.description || "Labor",
        quantity: formatMoney(line.quantity ?? 0),
        unitPrice: formatMoney(line.unitPrice ?? 0),
        lineTotal: formatMoney(line.lineTotal ?? 0),
      })),
    );
  }

  ensureSpace(doc, costInQuote ? 120 : 90);

  const subtotal = Number(document.subtotal ?? 0);
  const gst = Number(document.gst ?? 0);
  const total = Number(document.totalAmount ?? subtotal + gst);
  const gstRate = subtotal > 0 ? (gst / subtotal) * 100 : 0;

  const totalsX = X(doc) + contentW(doc) * 0.5;
  const totalsW = contentW(doc) * 0.5;

  doc
    .fillColor(BRAND.teal2)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text("Totals", totalsX, doc.y, { width: totalsW });

  doc.moveDown(0.5);

  const totals = costInQuote
    ? [
        ["Materials", formatMoney(document.materialTotal ?? 0)],
        ["Labor", formatMoney(document.laborTotal ?? 0)],
        ["Subtotal", formatMoney(subtotal)],
        [`GST (${gstRate.toFixed(2)}%)`, formatMoney(gst)],
        ["Total", formatMoney(total)],
      ]
    : [
        ["Subtotal", formatMoney(subtotal)],
        [`GST (${gstRate.toFixed(2)}%)`, formatMoney(gst)],
        ["Total", formatMoney(total)],
      ];

  totals.forEach(([label, value]) => {
    doc
      .fillColor(BRAND.text)
      .font("Helvetica")
      .fontSize(9)
      .text(label, totalsX, doc.y, { width: totalsW * 0.6 });
    doc.font("Helvetica-Bold").text(value, totalsX, doc.y - 12, {
      width: totalsW,
      align: "right",
    });
    doc.moveDown(0.4);
  });

  ensureSpace(doc, 90);

  doc
    .fillColor(BRAND.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(`Quote validity: ${TERMS.validityDays} days.`, X(doc), doc.y);
  doc
    .fillColor(BRAND.muted)
    .font("Helvetica")
    .fontSize(9)
    .text(`Payment terms: ${TERMS.paymentTerms}`, X(doc), doc.y + 14);

  doc.end();

  return await new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
