// scripts/import-state-mapping-considerations.mjs
//
// Imports Queensland state-mapping consideration layers used in Townplanner V2
// (SARA DA mapping, SPP benchmark mapping, and RPI priority living area)
// into PostGIS.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/import-state-mapping-considerations.mjs
//
// Optional flags:
//   --no-truncate        keep existing rows
//   --key=<layer-key>    import a single configured layer key
//   --layer-id=<id>      import all configured layers with this ArcGIS layer id
//   --start-oid=<n>      override cursor start object id (imports where OID > n)
//   --delay-ms=750       request pacing delay (default 750)
//   --page-size=1000     ArcGIS page size cap (default 1000)

import axios from "axios";
import pg from "pg";
import "dotenv/config";

const { Client } = pg;

const ARCGIS_BASE =
  process.env.STATE_MAPPING_ARCGIS_BASE_URL ||
  "https://arcgis.spp-dams.wspdigitaltesting.com/arcgis/rest/services";

const DAMS_REFERER =
  process.env.DAMS_REFERER || "https://sppims-dams.dsdilgp.qld.gov.au/";
const DAMS_ORIGIN =
  process.env.DAMS_ORIGIN || "https://sppims-dams.dsdilgp.qld.gov.au";

const LAYERS = [
  {
    key: "sara_seq_regional_plan_land_use_categories",
    servicePath: "SARA/SARA_Data/MapServer",
    id: 51,
    table: "qld_state_mapping_seq_regional_plan_land_use_categories",
  },
  {
    key: "sara_water_resource_planning_area_boundaries",
    servicePath: "SARA/SARA_Data/MapServer",
    id: 9,
    table: "qld_state_mapping_water_resource_planning_area_boundaries",
  },
  {
    key: "sara_regulated_vegetation_management_map",
    // Use the official Queensland Vegetation Management service "RVM - all"
    // so categories A/B/C/R/X/Water are available (not just A/B extract).
    baseUrl: "https://spatial-gis.information.qld.gov.au/arcgis/rest/services",
    servicePath: "Biota/VegetationManagement/MapServer",
    id: 109,
    table: "qld_state_mapping_regulated_vegetation_management_map",
  },
  {
    key: "spp_flood_hazard_lg_flood_mapping_area",
    servicePath: "SPP/SPP_Data/MapServer",
    id: 62,
    table: "qld_state_mapping_spp_flood_hazard_lg_flood_mapping_area",
  },
  {
    key: "rpi_priority_living_area",
    servicePath: "RPI/RPI_RegionalPlanningInterests/MapServer",
    id: 5,
    table: "qld_state_mapping_rpi_priority_living_area",
  },
];

const DEFAULT_DELAY_MS = Number(process.env.STATE_MAPPING_IMPORT_DELAY_MS || 750);
const DEFAULT_PAGE_SIZE = Number(process.env.STATE_MAPPING_IMPORT_PAGE_SIZE || 1000);
const BATCH_SIZE = 250;

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var ${name}. Example:`);
    console.error(
      `  export ${name}='postgresql://user:pass@host:5432/db?sslmode=require'`
    );
    process.exit(1);
  }
  return val;
}

function quoteIdent(ident) {
  return '"' + String(ident).replace(/"/g, '""') + '"';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    truncate: !argv.includes("--no-truncate"),
    layerId: null,
    key: null,
    startOid: null,
    delayMs: DEFAULT_DELAY_MS,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  for (const arg of argv) {
    if (arg.startsWith("--layer-id=")) {
      const v = Number(arg.slice("--layer-id=".length));
      if (Number.isFinite(v)) options.layerId = v;
    }
    if (arg.startsWith("--key=")) {
      const v = String(arg.slice("--key=".length)).trim();
      if (v) options.key = v;
    }
    if (arg.startsWith("--start-oid=")) {
      const v = Number(arg.slice("--start-oid=".length));
      if (Number.isFinite(v)) options.startOid = Math.floor(v);
    }
    if (arg.startsWith("--delay-ms=")) {
      const v = Number(arg.slice("--delay-ms=".length));
      if (Number.isFinite(v) && v >= 0) options.delayMs = v;
    }
    if (arg.startsWith("--page-size=")) {
      const v = Number(arg.slice("--page-size=".length));
      if (Number.isFinite(v) && v > 0) options.pageSize = v;
    }
  }

  return options;
}

async function ensureTable(client, tableNameRaw) {
  const tableName = quoteIdent(tableNameRaw);

  await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id         bigserial PRIMARY KEY,
      properties jsonb NOT NULL DEFAULT '{}'::jsonb,
      geom       geometry(Geometry, 4326) NOT NULL
    );
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(
      tableNameRaw + "__geom_gist"
    )} ON ${tableName} USING GIST (geom);`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(
      tableNameRaw + "__props_gin"
    )} ON ${tableName} USING GIN (properties);`
  );
}

async function requestJson(url, { params, delayMs, retries = 4 }) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      if (delayMs > 0) {
        const jitter = Math.floor(Math.random() * 120);
        await sleep(delayMs + jitter);
      }
      const resp = await axios.get(url, {
        params,
        timeout: 30000,
        headers: {
          Referer: DAMS_REFERER,
          Origin: DAMS_ORIGIN,
        },
      });
      return resp.data;
    } catch (err) {
      const status = err?.response?.status || 0;
      const retryable = status >= 500 || status === 429 || status === 0;
      if (!retryable || attempt === retries) throw err;
      const backoffMs = Math.min(3000 * 2 ** attempt, 20000);
      await sleep(backoffMs);
      attempt += 1;
    }
  }
  throw new Error("Unexpected request retry loop termination");
}

function getObjectIdFieldName(layerMeta) {
  const fields = Array.isArray(layerMeta?.fields) ? layerMeta.fields : [];
  const oidField = fields.find((f) => f?.type === "esriFieldTypeOID");
  if (oidField?.name) return oidField.name;
  return "OBJECTID";
}

async function fetchLayerMetadata(layer, delayMs) {
  const baseUrl = String(layer?.baseUrl || ARCGIS_BASE).replace(/\/+$/, "");
  const url = `${baseUrl}/${layer.servicePath}/${layer.id}`;
  return requestJson(url, {
    params: { f: "pjson" },
    delayMs,
  });
}

function readFieldCI(props, fieldName) {
  if (!props || typeof props !== "object") return null;
  if (
    Object.prototype.hasOwnProperty.call(props, fieldName) &&
    props[fieldName] != null
  ) {
    return props[fieldName];
  }
  const wanted = String(fieldName || "").toLowerCase();
  for (const [k, v] of Object.entries(props)) {
    if (String(k).toLowerCase() === wanted && v != null) return v;
  }
  return null;
}

function readFeatureObjectId(feature, orderByField) {
  const props = feature?.properties;
  if (!props || typeof props !== "object") return null;

  const candidates = [orderByField, "OBJECTID", "objectid", "ObjectId", "OID"];
  for (const field of candidates) {
    const raw = readFieldCI(props, field);
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function fetchLayerFeaturesPage({
  layer,
  delayMs,
  pageSize,
  orderByField,
  lastOid,
}) {
  const baseUrl = String(layer?.baseUrl || ARCGIS_BASE).replace(/\/+$/, "");
  const url = `${baseUrl}/${layer.servicePath}/${layer.id}/query`;
  const cursor = Number.isFinite(Number(lastOid))
    ? Math.floor(Number(lastOid))
    : -1;
  const whereClause = `${orderByField} > ${cursor}`;
  return requestJson(url, {
    params: {
      where: whereClause,
      outFields: "*",
      f: "geojson",
      resultRecordCount: pageSize,
      orderByFields: `${orderByField} ASC`,
    },
    delayMs,
  });
}

function pageSizeCandidates(basePageSize) {
  const seed = Math.max(1, Math.floor(Number(basePageSize) || 1));
  const sizes = [seed];
  let current = seed;
  while (current > 1) {
    current = Math.max(1, Math.floor(current / 2));
    if (!sizes.includes(current)) sizes.push(current);
    if (current === 1) break;
  }
  return sizes;
}

async function resolveInitialCursor(client, tableNameRaw, orderByField, options) {
  if (options?.startOid != null && Number.isFinite(Number(options.startOid))) {
    return Math.floor(Number(options.startOid));
  }
  if (options?.truncate) return -1;

  const tableName = quoteIdent(tableNameRaw);
  const sql = `
    SELECT COALESCE(MAX(
      CASE
        WHEN properties ? $1 AND (properties->>$1) ~ '^[0-9]+$'
          THEN (properties->>$1)::bigint
        WHEN properties ? 'OBJECTID' AND (properties->>'OBJECTID') ~ '^[0-9]+$'
          THEN (properties->>'OBJECTID')::bigint
        WHEN properties ? 'objectid' AND (properties->>'objectid') ~ '^[0-9]+$'
          THEN (properties->>'objectid')::bigint
        ELSE NULL
      END
    ), -1) AS max_oid
    FROM ${tableName}
  `;
  const { rows } = await client.query(sql, [String(orderByField || "OBJECTID")]);
  return Number(rows?.[0]?.max_oid || -1);
}

async function flushBatch(client, table, batch) {
  if (!batch.length) return 0;

  const values = [];
  const rowsSql = batch
    .map((row, idx) => {
      const p1 = idx * 2 + 1;
      const p2 = idx * 2 + 2;
      values.push(row.props, row.geomJson);
      return `($${p1}::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($${p2}), 4326))`;
    })
    .join(",");

  const sql = `INSERT INTO ${quoteIdent(
    table
  )} (properties, geom) VALUES ${rowsSql};`;
  await client.query(sql, values);
  return batch.length;
}

async function importLayer(client, layer, options) {
  const { truncate, delayMs, pageSize } = options;

  await ensureTable(client, layer.table);
  if (truncate) {
    await client.query(`TRUNCATE TABLE ${quoteIdent(layer.table)};`);
  }

  const layerMeta = await fetchLayerMetadata(layer, delayMs);
  const layerName = layerMeta?.name || layer.key;
  const maxRecordCount = Number(layerMeta?.maxRecordCount || 2000);
  const effectivePageSize = Math.max(1, Math.min(pageSize, maxRecordCount));
  const orderByField = getObjectIdFieldName(layerMeta);

  console.log(`\nLayer ${layer.key} (${layer.servicePath}/${layer.id})`);
  console.log(
    `Table: ${layer.table} | pageSize=${effectivePageSize} | orderBy=${orderByField}`
  );

  let lastOid = await resolveInitialCursor(client, layer.table, orderByField, options);
  if (lastOid >= 0) {
    console.log(`Resuming cursor at object id > ${lastOid}`);
  }
  let totalInserted = 0;
  let pageNumber = 0;
  let batch = [];
  const importedAt = new Date().toISOString();
  let consecutiveSkippedCursors = 0;

  while (true) {
    let page = null;
    let usedPageSize = effectivePageSize;
    let lastFetchError = null;
    for (const candidateSize of pageSizeCandidates(effectivePageSize)) {
      try {
        page = await fetchLayerFeaturesPage({
          layer,
          delayMs,
          pageSize: candidateSize,
          orderByField,
          lastOid,
        });
        usedPageSize = candidateSize;
        lastFetchError = null;
        break;
      } catch (err) {
        lastFetchError = err;
      }
    }

    if (!page) {
      const oldCursor = lastOid;
      lastOid += 1;
      consecutiveSkippedCursors += 1;
      console.warn(
        `\n⚠️ Query failed after object id ${oldCursor}; skipping to > ${lastOid}. Error: ${
          lastFetchError?.message || lastFetchError
        }`
      );
      if (consecutiveSkippedCursors > 1000) {
        throw new Error(
          `Aborting after ${consecutiveSkippedCursors} consecutive cursor skips at ${layer.key}`
        );
      }
      continue;
    }
    consecutiveSkippedCursors = 0;
    if (usedPageSize !== effectivePageSize) {
      console.warn(
        `\n⚠️ Reduced page size to ${usedPageSize} for cursor > ${lastOid}`
      );
    }

    const features = Array.isArray(page?.features) ? page.features : [];
    if (!features.length) break;

    let maxPageOid = lastOid;
    for (const feature of features) {
      if (!feature?.geometry) continue;
      const featureOid = readFeatureObjectId(feature, orderByField);
      if (Number.isFinite(featureOid)) {
        maxPageOid = Math.max(maxPageOid, featureOid);
      }

      const props = {
        ...(feature.properties || {}),
        ...(Number.isFinite(featureOid)
          ? { __source_object_id: Math.floor(featureOid) }
          : {}),
        __source: "qld_state_mapping_considerations",
        __source_layer_key: layer.key,
        __source_service_path: layer.servicePath,
        __source_layer_id: layer.id,
        __source_layer_name: layerName,
        __imported_at: importedAt,
      };

      batch.push({
        props,
        geomJson: JSON.stringify(feature.geometry),
      });

      if (batch.length >= BATCH_SIZE) {
        totalInserted += await flushBatch(client, layer.table, batch);
        batch = [];
      }
    }

    pageNumber += 1;
    process.stdout.write(
      `\r  pages=${String(pageNumber).padStart(4, " ")} inserted=${String(
        totalInserted + batch.length
      ).padStart(7, " ")}`
    );

    if (maxPageOid <= lastOid) {
      throw new Error(
        `Unable to advance object id cursor for ${layer.key} (lastOid=${lastOid})`
      );
    }
    lastOid = maxPageOid;
    if (features.length < effectivePageSize) break;
  }

  if (batch.length) {
    totalInserted += await flushBatch(client, layer.table, batch);
  }

  process.stdout.write("\n");
  console.log(`✅ Imported ${totalInserted} features into ${layer.table}`);
}

async function main() {
  const connectionString = requireEnv("DATABASE_URL");
  const options = parseArgs(process.argv.slice(2));

  let selected = LAYERS;
  if (options.key) {
    selected = selected.filter((layer) => layer.key === options.key);
  }
  if (options.layerId != null) {
    selected = selected.filter((layer) => layer.id === options.layerId);
  }

  if (!selected.length) {
    console.error(
      `No matching layer selected. Keys: ${LAYERS.map((x) => x.key).join(", ")}`
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: connectionString.includes("neon.tech")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  await client.connect();

  try {
    console.log(
      `Starting state-mapping import for ${selected.length} layer(s)...`
    );
    for (const layer of selected) {
      await importLayer(client, layer, options);
    }
    console.log("\nAll selected state-mapping layers imported successfully.");
  } catch (err) {
    console.error("\nImport failed:", err?.message || err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
