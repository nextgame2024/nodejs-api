// scripts/extract-np-tables-to-sql.mjs
// Usage:
//   node scripts/extract-np-tables-to-sql.mjs \
//     --input /path/to/fullplan.pdf \
//     --out scripts/seed_neighbourhood_plans.sql \
//     --json-out scripts/seed_neighbourhood_plans.json
//
// Optional:
//   --input https://files-nodejs-api.../fullplan.pdf
//   --plan "Aspley district neighbourhood plan"   (filter one plan)
//   --scheme "City Plan 2014"                    (default)
//   --source-url "https://cityplan..."           (default: empty -> NULL)
//   --citation-template "{plan} Tables of assessment" (default)
//
// Notes:
// - Requires pdf-parse. Run `npm install` in backend first.
// - Output controls JSON is stored in bcc_planning_controls_v2.controls (jsonb).

import fs from "fs";
import path from "path";
import axios from "axios";
import pdf from "pdf-parse";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    input: null,
    out: "scripts/seed_neighbourhood_plans.sql",
    jsonOut: "scripts/seed_neighbourhood_plans.json",
    plan: null,
    scheme: "City Plan 2014",
    sourceUrl: "",
    citationTemplate: "{plan} Tables of assessment",
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--input") {
      out.input = args[i + 1];
      i += 1;
    } else if (a === "--out") {
      out.out = args[i + 1];
      i += 1;
    } else if (a === "--json-out") {
      out.jsonOut = args[i + 1];
      i += 1;
    } else if (a === "--plan") {
      out.plan = args[i + 1];
      i += 1;
    } else if (a === "--scheme") {
      out.scheme = args[i + 1];
      i += 1;
    } else if (a === "--source-url") {
      out.sourceUrl = args[i + 1];
      i += 1;
    } else if (a === "--citation-template") {
      out.citationTemplate = args[i + 1];
      i += 1;
    }
  }
  return out;
}

function ensureInput(input) {
  if (!input) {
    console.error("Missing --input. Example: --input /path/to/fullplan.pdf");
    process.exit(1);
  }
}

async function loadPdfBuffer(input) {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const resp = await axios.get(input, { responseType: "arraybuffer" });
    return Buffer.from(resp.data);
  }
  return fs.readFileSync(input);
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLine(line) {
  return String(line || "").replace(/\s+$/g, "").replace(/\u00A0/g, " ");
}

function splitColumns(line) {
  return line
    .split(/\s{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitHeaderColumns(line) {
  const parts = splitColumns(line);
  if (parts.length >= 2) return parts;
  const normalized = normalizeText(line);
  const lower = normalized.toLowerCase();
  if (!lower.includes("assessment benchmarks")) return parts;

  const catIdx = lower.indexOf("categories of development and assessment");
  const benchIdx = lower.indexOf("assessment benchmarks");
  if (catIdx >= 0 && benchIdx > catIdx) {
    const first = normalized.slice(0, catIdx).trim();
    const second = normalized.slice(catIdx, benchIdx).trim();
    const third = normalized.slice(benchIdx).trim();
    return [first || "Use", second, third].filter((p) => p.length);
  }
  return parts;
}

function parseTableTitle(line) {
  const match = line.match(/Table\s*([0-9.]+[A-Z]?)\s*[—-]\s*(.+)$/i);
  if (!match) return null;
  const id = `Table ${match[1]}`;
  const title = match[2].trim();
  let plan = title;
  let type = "";
  if (title.includes(":")) {
    const parts = title.split(":");
    plan = parts.shift().trim();
    type = parts.join(":").trim();
  }
  return { id, title: `Table ${match[1]}—${title}`, plan, type };
}

function isHeaderLine(line) {
  const lower = line.toLowerCase();
  return (
    lower.includes("assessment benchmarks") &&
    lower.includes("development")
  );
}

function isSectionHeading(line, parts) {
  if (!line) return false;
  if (parts.length > 1) return false;
  const lower = line.toLowerCase();
  if (lower.startsWith("if ")) return true;
  if (lower.includes("precinct")) return true;
  if (lower.includes("neighbourhood plan area")) return true;
  if (lower.includes("zone")) return true;
  return false;
}

function padCells(parts, count) {
  const cells = parts.slice(0, count);
  while (cells.length < count) cells.push("");
  if (cells.length > count) {
    const extras = cells.splice(count - 1);
    cells[count - 1] = extras.join(" ").trim();
  }
  return cells;
}

function isSectionHeadingText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.startsWith("if ")) return true;
  if (lower.includes("precinct")) return true;
  if (lower.includes("neighbourhood plan area")) return true;
  if (lower.includes("zone")) return true;
  return false;
}

function isPageMetaLine(text) {
  const line = normalizeText(text).toLowerCase();
  if (!line) return false;
  if (line.startsWith("brisbane city council city plan 2014")) return true;
  if (line.startsWith("part 5 tables of assessment")) return true;
  if (line.startsWith("effective date:")) return true;
  if (line.startsWith("status:")) return true;
  if (/^page\s+\d+\s+of\s+\d+$/i.test(line)) return true;
  if (line.startsWith("print date:")) return true;
  if (line === "cityplan.brisbane.qld.gov.au") return true;
  return false;
}

function appendToColumn(row, colIndex, text) {
  if (!row) return;
  const idx =
    Number.isInteger(colIndex) && colIndex >= 0 && colIndex < row.cells.length
      ? colIndex
      : row.cells.findIndex((c) => c.trim().length > 0);
  const targetIdx = idx >= 0 ? idx : row.cells.length - 1;
  row.cells[targetIdx] = row.cells[targetIdx]
    ? `${row.cells[targetIdx]}\n${text}`
    : text;
}

function buildRow(cells) {
  return {
    cells,
    row_notes: {
      is_header_row: false,
      has_merged_cells: false,
      merge_map: null,
    },
  };
}

function groupItemsIntoLines(items, yTolerance = 2.5) {
  const lines = [];
  const sorted = items
    .filter((item) => item.text && item.text.trim())
    .slice()
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  for (const item of sorted) {
    let line = lines.find((l) => Math.abs(l.y - item.y) <= yTolerance);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = normalizeText(line.items.map((i) => i.text).join(" "));
  }

  return lines.sort((a, b) => b.y - a.y);
}

function detectHeaderColumns(line) {
  const items = line.items;
  const findItem = (re) =>
    items.find((item) => re.test(item.text.toLowerCase()));

  const firstColItem = findItem(/\b(use|development)\b/);
  const catItem = findItem(/categories/);
  const benchItem = findItem(/benchmarks/);
  if (!firstColItem || !catItem || !benchItem) return null;

  const starts = [
    {
      x: firstColItem.x,
      key: /^development$/i.test(firstColItem.text.trim())
        ? "Development"
        : "Use",
    },
    { x: catItem.x, key: "Categories of development and assessment" },
    { x: benchItem.x, key: "Assessment benchmarks" },
  ].sort((a, b) => a.x - b.x);

  const boundaries = [
    (starts[0].x + starts[1].x) / 2,
    (starts[1].x + starts[2].x) / 2,
  ];

  const headers = [[], [], []];
  for (const item of items) {
    const idx = item.x < boundaries[0] ? 0 : item.x < boundaries[1] ? 1 : 2;
    headers[idx].push(item.text);
  }

  return {
    headers: headers.map((parts, i) =>
      parts.length ? normalizeText(parts.join(" ")) : starts[i].key
    ),
    boundaries,
  };
}

function splitLineIntoColumns(line, boundaries) {
  const cols = [[], [], []];
  for (const item of line.items) {
    const idx = item.x < boundaries[0] ? 0 : item.x < boundaries[1] ? 1 : 2;
    cols[idx].push(item);
  }
  return cols.map((col) =>
    normalizeText(col.sort((a, b) => a.x - b.x).map((i) => i.text).join(" "))
  );
}

function parseTablesFromLinePages(pages) {
  const tables = [];
  let currentTable = null;
  let currentSection = null;
  let headerCount = 0;
  let columnBoundaries = null;

  const closeTable = () => {
    if (currentTable) {
      tables.push(currentTable);
    }
    currentTable = null;
    currentSection = null;
    headerCount = 0;
  };

  pages.forEach((pageLines, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const lines = pageLines;

    for (const line of lines) {
      if (isPageMetaLine(line.text)) continue;

      const title = parseTableTitle(line.text);
      if (title) {
        closeTable();
        currentTable = {
          table_id: title.id,
          table_title: title.title,
          plan: title.plan,
          type: title.type || "",
          headers: [],
          sections: [],
          footnotes: [],
          pdf_locator: {
            page_numbers: [pageNumber],
            bbox_hint: null,
          },
        };
        columnBoundaries = null;
        continue;
      }

      if (!currentTable) continue;
      if (!currentTable.pdf_locator.page_numbers.includes(pageNumber)) {
        currentTable.pdf_locator.page_numbers.push(pageNumber);
      }

      if (!currentTable.headers.length && isHeaderLine(line.text)) {
        const headerInfo = detectHeaderColumns(line);
        if (!headerInfo) continue;
        currentTable.headers = headerInfo.headers;
        headerCount = headerInfo.headers.length;
        columnBoundaries = headerInfo.boundaries;
        currentSection = {
          title: "",
          rows: [],
        };
        currentTable.sections.push(currentSection);
        continue;
      }

      if (!currentTable.headers.length) {
        continue;
      }

      if (!columnBoundaries) continue;
      const cells = splitLineIntoColumns(line, columnBoundaries);
      const nonEmptyCols = cells
        .map((c, idx) => (c ? idx : -1))
        .filter((idx) => idx >= 0);
      if (!nonEmptyCols.length) continue;

      if (
        nonEmptyCols.length === 1 &&
        nonEmptyCols[0] === 0 &&
        isSectionHeadingText(cells[0])
      ) {
        currentSection = {
          title: cells[0],
          rows: [],
        };
        currentTable.sections.push(currentSection);
        continue;
      }

      if (!currentSection) {
        currentSection = {
          title: "",
          rows: [],
        };
        currentTable.sections.push(currentSection);
      }

      if (nonEmptyCols.length === 1 && currentSection.rows.length) {
        const lastRow = currentSection.rows[currentSection.rows.length - 1];
        appendToColumn(lastRow, nonEmptyCols[0], cells[nonEmptyCols[0]]);
        continue;
      }

      currentSection.rows.push(buildRow(cells));
    }
  });

  closeTable();
  return tables;
}

function parseTablesFromTextPages(pages) {
  const tables = [];
  let currentTable = null;
  let currentSection = null;
  let headerCount = 0;

  const closeTable = () => {
    if (currentTable) {
      tables.push(currentTable);
    }
    currentTable = null;
    currentSection = null;
    headerCount = 0;
  };

  pages.forEach((pageText, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const lines = pageText
      .split(/\r?\n/)
      .map(normalizeLine)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
      if (isPageMetaLine(line)) continue;

      const title = parseTableTitle(line);
      if (title) {
        closeTable();
        currentTable = {
          table_id: title.id,
          table_title: title.title,
          plan: title.plan,
          type: title.type || "",
          headers: [],
          sections: [],
          footnotes: [],
          pdf_locator: {
            page_numbers: [pageNumber],
            bbox_hint: null,
          },
        };
        continue;
      }

      if (!currentTable) continue;
      if (!currentTable.pdf_locator.page_numbers.includes(pageNumber)) {
        currentTable.pdf_locator.page_numbers.push(pageNumber);
      }

      if (!currentTable.headers.length && isHeaderLine(line)) {
        const headers = splitHeaderColumns(line);
        currentTable.headers = headers;
        headerCount = headers.length || 0;
        currentSection = {
          title: "",
          rows: [],
        };
        currentTable.sections.push(currentSection);
        continue;
      }

      if (!currentTable.headers.length) {
        continue;
      }

      const parts = splitColumns(line);
      if (!parts.length) continue;

      if (isSectionHeading(line, parts)) {
        currentSection = {
          title: line,
          rows: [],
        };
        currentTable.sections.push(currentSection);
        continue;
      }

      if (!currentSection) {
        currentSection = {
          title: "",
          rows: [],
        };
        currentTable.sections.push(currentSection);
      }

      if (headerCount && parts.length < headerCount && currentSection.rows.length) {
        const lastRow = currentSection.rows[currentSection.rows.length - 1];
        // Fallback parser: continuation lines in this dataset most commonly
        // continue the first column text.
        appendToColumn(lastRow, 0, parts.join(" "));
        continue;
      }

      const cells = headerCount ? padCells(parts, headerCount) : parts;
      currentSection.rows.push(buildRow(cells));
    }
  });

  closeTable();
  return tables;
}

function groupByPlan(tables, schemeVersion, sourceUrl) {
  const map = new Map();
  for (const table of tables) {
    const plan = table.plan || "Unknown";
    if (!map.has(plan)) {
      map.set(plan, {
        scheme_version: schemeVersion,
        neighbourhood_plan: plan,
        source_url: sourceUrl || "",
        tables: [],
      });
    }
    map.get(plan).tables.push(table);
  }
  return Array.from(map.values());
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function buildSql(plans, options) {
  const rows = plans.map((plan) => {
    const citation = options.citationTemplate.replace("{plan}", plan.neighbourhood_plan);
    const controlsJson = JSON.stringify(plan);
    const sourceUrl = options.sourceUrl || plan.source_url || "";
    const sourceVal = sourceUrl ? `'${sqlEscape(sourceUrl)}'` : "NULL";
    return `INSERT INTO bcc_planning_controls_v2 (scheme_version, label, neighbourhood_plan, source_url, source_citation, controls) VALUES ('${sqlEscape(options.scheme)}', '${sqlEscape(plan.neighbourhood_plan)}', '${sqlEscape(plan.neighbourhood_plan)}', ${sourceVal}, '${sqlEscape(citation)}', '${sqlEscape(controlsJson)}'::jsonb);`;
  });
  return rows.join("\n");
}

async function extractPages(buffer) {
  const pages = [];
  const data = await pdf(buffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      const items = textContent.items.map((item) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
      }));
      return `${JSON.stringify(items)}\f`;
    },
  });

  const rawPages = data.text.split(/\f/).filter(Boolean);
  for (const raw of rawPages) {
    try {
      const items = JSON.parse(raw);
      pages.push(groupItemsIntoLines(items));
    } catch {
      pages.push([]);
    }
  }

  const hasContent = pages.some((p) => p.length > 0);
  if (hasContent) {
    return { mode: "coords", pages };
  }

  const fallback = await pdf(buffer);
  const textPages = fallback.text.split(/\f/);
  return { mode: "text", pages: textPages };
}

async function main() {
  const opts = parseArgs();
  ensureInput(opts.input);

  const buffer = await loadPdfBuffer(opts.input);
  const extracted = await extractPages(buffer);

  let tables =
    extracted.mode === "coords"
      ? parseTablesFromLinePages(extracted.pages)
      : parseTablesFromTextPages(extracted.pages);
  if (opts.plan) {
    const target = opts.plan.toLowerCase();
    tables = tables.filter((t) => (t.plan || "").toLowerCase() === target);
  }

  const plans = groupByPlan(tables, opts.scheme, opts.sourceUrl);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.mkdirSync(path.dirname(opts.jsonOut), { recursive: true });

  fs.writeFileSync(opts.jsonOut, JSON.stringify(plans, null, 2));
  fs.writeFileSync(opts.out, buildSql(plans, opts));

  console.log(`Wrote ${plans.length} plan(s) to ${opts.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
