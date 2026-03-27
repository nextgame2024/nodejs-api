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

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function decodeHtmlEntitiesDeep(value, iterations = 4) {
  let current = String(value ?? "");
  for (let i = 0; i < iterations; i += 1) {
    const decoded = decodeHtmlEntities(current);
    if (decoded === current) break;
    current = decoded;
  }
  return current;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseInlineFontSize(attrs) {
  if (!attrs) return null;

  const fontSizeAttr = attrs.match(/\bsize\s*=\s*["']?(\d+)["']?/i);
  if (fontSizeAttr) {
    const sizeMap = {
      1: 8,
      2: 9,
      3: 10,
      4: 12,
      5: 14,
      6: 18,
      7: 24,
    };
    const mapped = sizeMap[Number(fontSizeAttr[1])];
    if (mapped) return mapped;
  }

  const styleAttr =
    attrs.match(/\bstyle\s*=\s*"([^"]*)"/i)?.[1] ||
    attrs.match(/\bstyle\s*=\s*'([^']*)'/i)?.[1] ||
    "";
  if (!styleAttr) return null;

  const sizeMatch = styleAttr.match(
    /font-size\s*:\s*([0-9.]+)\s*(px|pt|em|rem)?/i,
  );
  if (!sizeMatch) return null;

  const raw = Number(sizeMatch[1]);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  const unit = (sizeMatch[2] || "px").toLowerCase();
  let pt = raw;
  if (unit === "px") pt = raw * 0.75;
  if (unit === "em" || unit === "rem") pt = raw * 10;
  return clampNumber(pt, 8, 24);
}

function parseBlockMeta(attrs) {
  const meta = { align: null, indent: 0, fontSize: null };
  if (!attrs) return meta;

  const alignAttr = attrs.match(/\balign\s*=\s*["']?([a-z]+)["']?/i)?.[1];
  if (alignAttr) {
    const normalized = alignAttr.toLowerCase();
    if (["left", "center", "right", "justify"].includes(normalized)) {
      meta.align = normalized;
    }
  }

  const styleAttr =
    attrs.match(/\bstyle\s*=\s*"([^"]*)"/i)?.[1] ||
    attrs.match(/\bstyle\s*=\s*'([^']*)'/i)?.[1] ||
    "";
  if (!styleAttr) return meta;

  const alignStyle = styleAttr.match(/text-align\s*:\s*([a-z]+)/i)?.[1];
  if (alignStyle) {
    const normalized = alignStyle.toLowerCase();
    if (["left", "center", "right", "justify"].includes(normalized)) {
      meta.align = normalized;
    }
  }

  const indentMatch = styleAttr.match(
    /(margin-left|padding-left)\s*:\s*([0-9.]+)\s*(px|pt|em|rem)?/i,
  );
  if (indentMatch) {
    const raw = Number(indentMatch[2]);
    if (Number.isFinite(raw) && raw > 0) {
      const unit = (indentMatch[3] || "px").toLowerCase();
      let points = raw;
      if (unit === "px") points = raw * 0.75;
      if (unit === "em" || unit === "rem") points = raw * 10;
      meta.indent = clampNumber(points, 0, 120);
    }
  }

  const inlineFont = parseInlineFontSize(`style="${styleAttr}"`);
  if (inlineFont) meta.fontSize = inlineFont;

  return meta;
}

function richTextToStyledLines(value, defaultFontSize = 10) {
  const raw = clean(value);
  if (!raw) return [];

  const source = decodeHtmlEntitiesDeep(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const tokens = source.match(/<[^>]+>|[^<]+/g) || [];

  const blockStack = [{ align: "left", indent: 0, fontSize: null }];
  const inlineFontStack = [];
  let boldCount = 0;
  let italicCount = 0;
  let underlineCount = 0;
  const lines = [];
  let currentText = "";
  let currentStyle = {
    align: "left",
    indent: 0,
    bold: false,
    italic: false,
    underline: false,
    fontSize: null,
  };

  const currentBlock = () => blockStack[blockStack.length - 1];
  const currentInlineSize = () => {
    for (let i = inlineFontStack.length - 1; i >= 0; i -= 1) {
      if (inlineFontStack[i]) return inlineFontStack[i];
    }
    return null;
  };
  const effectiveFontSize = () =>
    currentInlineSize() || currentBlock().fontSize || defaultFontSize;
  const normalizeAlign = (value) =>
    ["left", "center", "right", "justify"].includes(value) ? value : "left";
  const hasVisibleText = () => currentText.replace(/\s+/g, "").length > 0;
  const refreshStyle = () => {
    currentStyle = {
      align: normalizeAlign(currentBlock().align || "left"),
      indent: Math.max(0, Number(currentBlock().indent || 0)),
      bold: boldCount > 0,
      italic: italicCount > 0,
      underline: underlineCount > 0,
      fontSize: effectiveFontSize(),
    };
  };

  const flushLine = ({ preserveBlank = false } = {}) => {
    const text = currentText.replace(/[ \t]+$/g, "");
    if (text.trim().length > 0) {
      lines.push({
        text: text.trim(),
        align: normalizeAlign(currentStyle.align),
        indent: currentStyle.indent,
        bold: currentStyle.bold,
        italic: currentStyle.italic,
        underline: currentStyle.underline,
        fontSize: currentStyle.fontSize || defaultFontSize,
      });
    } else if (preserveBlank) {
      lines.push({ blank: true });
    }
    currentText = "";
    refreshStyle();
  };

  const appendText = (text) => {
    if (!text) return;
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      if (part.length > 0) {
        refreshStyle();
        currentText += part;
      }
      if (index < parts.length - 1) {
        flushLine({ preserveBlank: true });
      }
    });
  };

  const openBlock = (tagName, attrs) => {
    if (hasVisibleText()) flushLine();
    const parent = currentBlock();
    const meta = parseBlockMeta(attrs);
    const headingLevel = tagName.match(/^h([1-6])$/i)?.[1];
    const headingSizeMap = { 1: 20, 2: 18, 3: 16, 4: 14, 5: 12, 6: 11 };
    const headingSize = headingLevel
      ? headingSizeMap[Number(headingLevel)] || 12
      : null;
    const block = {
      align: meta.align || (tagName === "center" ? "center" : parent.align),
      indent:
        (parent.indent || 0) +
        (meta.indent || 0) +
        (tagName === "blockquote" ? 16 : 0) +
        (tagName === "li" ? 10 : 0),
      fontSize: meta.fontSize || headingSize || parent.fontSize || null,
    };
    blockStack.push(block);
    if (headingLevel) boldCount += 1;
    if (tagName === "li") appendText("• ");
    refreshStyle();
  };

  const closeBlock = (tagName) => {
    if (hasVisibleText()) flushLine();
    if (tagName.match(/^h[1-6]$/i)) {
      boldCount = Math.max(0, boldCount - 1);
    }
    if (blockStack.length > 1) blockStack.pop();
    refreshStyle();
  };

  tokens.forEach((token) => {
    if (token.startsWith("<")) {
      const match = token.match(/^<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/i);
      if (!match) return;
      const closing = Boolean(match[1]);
      const tagName = match[2].toLowerCase();
      const attrs = match[3] || "";
      const selfClosing = /\/\s*>$/.test(token);

      if (tagName === "br") {
        flushLine({ preserveBlank: true });
        return;
      }

      const isBlockTag =
        tagName === "div" ||
        tagName === "p" ||
        tagName === "li" ||
        tagName === "ul" ||
        tagName === "ol" ||
        tagName === "blockquote" ||
        tagName === "center" ||
        /^h[1-6]$/.test(tagName);

      if (isBlockTag) {
        if (closing || selfClosing) closeBlock(tagName);
        else openBlock(tagName, attrs);
        return;
      }

      if (!closing) {
        if (tagName === "b" || tagName === "strong") boldCount += 1;
        if (tagName === "i" || tagName === "em") italicCount += 1;
        if (tagName === "u") underlineCount += 1;
        if (tagName === "span" || tagName === "font") {
          inlineFontStack.push(parseInlineFontSize(attrs));
        }
      } else {
        if (tagName === "b" || tagName === "strong") {
          boldCount = Math.max(0, boldCount - 1);
        }
        if (tagName === "i" || tagName === "em") {
          italicCount = Math.max(0, italicCount - 1);
        }
        if (tagName === "u") {
          underlineCount = Math.max(0, underlineCount - 1);
        }
        if ((tagName === "span" || tagName === "font") && inlineFontStack.length) {
          inlineFontStack.pop();
        }
      }

      refreshStyle();
      return;
    }

    appendText(token);
  });

  if (hasVisibleText()) flushLine();

  return lines;
}

function richTextToPlain(value) {
  const lines = richTextToStyledLines(value, 10);
  if (!lines.length) return null;
  const text = lines
    .map((line) => (line.blank ? "" : line.text))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function richTextFontName({ bold, italic }) {
  if (bold && italic) return "Helvetica-BoldOblique";
  if (bold) return "Helvetica-Bold";
  if (italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function drawRichTextBlock(doc, value, x, y, width, options = {}) {
  const defaultFontSize = options.defaultFontSize || 10;
  const color = options.color || BRAND.mutedLight;
  const lineGap = Number.isFinite(options.lineGap) ? options.lineGap : 2;
  const lines = richTextToStyledLines(value, defaultFontSize);
  if (!lines.length) return { height: 0 };

  let cursorY = y;
  lines.forEach((line) => {
    if (line.blank) {
      cursorY += Math.max(4, defaultFontSize * 0.66);
      return;
    }

    const indent = clampNumber(Number(line.indent || 0), 0, Math.max(0, width - 12));
    const drawW = Math.max(12, width - indent);
    doc
      .fillColor(color)
      .font(richTextFontName(line))
      .fontSize(clampNumber(Number(line.fontSize || defaultFontSize), 8, 24))
      .text(line.text, x + indent, cursorY, {
        width: drawW,
        align: ["left", "center", "right", "justify"].includes(line.align)
          ? line.align
          : "left",
        lineGap,
        underline: Boolean(line.underline),
      });
    cursorY = doc.y;
  });

  return { height: Math.max(0, cursorY - y) };
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
    clean(client?.ownerName),
    clean(client?.abn) ? `Abn: ${clean(client?.abn)}` : null,
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

  const scopeLayout = drawRichTextBlock(doc, scopeText, x, y, leftW, {
    defaultFontSize: 10,
    color: BRAND.mutedLight,
    lineGap: 2,
  });
  const leftHeight = scopeLayout.height;

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

  const projectDescription = richTextToPlain(project?.description);
  if (!costInQuote && projectDescription) {
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
      .text(projectDescription, X(doc), doc.y + 14, {
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
