// scripts/import-dams-state-transport.mjs
//
// Imports Queensland DAMS State Transport layers (ArcGIS REST) into PostGIS.
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/import-dams-state-transport.mjs [--no-truncate] [--layer=<id>] [--delay-ms=750] [--page-size=1000]
//
// Notes:
// - Uses ArcGIS MapServer query endpoint with pagination.
// - Sends Referer/Origin headers expected by DAMS ArcGIS host.
// - Imports each layer into its own table (properties jsonb + geom geometry).

import axios from "axios";
import pg from "pg";
import "dotenv/config";

const { Client } = pg;

const MAPSERVER_BASE =
  process.env.DAMS_ARCGIS_MAPSERVER_URL ||
  "https://arcgis.spp-dams.wspdigitaltesting.com/arcgis/rest/services/SARA/SARA_Data/MapServer";

const DAMS_REFERER =
  process.env.DAMS_REFERER || "https://sppims-dams.dsdilgp.qld.gov.au/";
const DAMS_ORIGIN =
  process.env.DAMS_ORIGIN || "https://sppims-dams.dsdilgp.qld.gov.au";

const STATE_TRANSPORT_LAYERS = [
  {
    id: 19,
    key: "area_within_25m_railway_corridor",
    table: "qld_dams_state_transport_25m_railway_corridor",
  },
  {
    id: 20,
    key: "area_within_25m_state_controlled_road",
    table: "qld_dams_state_transport_25m_state_controlled_road",
  },
  {
    id: 21,
    key: "area_within_25m_busway_corridor",
    table: "qld_dams_state_transport_25m_busway_corridor",
  },
  {
    id: 22,
    key: "area_within_25m_light_rail_corridor",
    table: "qld_dams_state_transport_25m_light_rail_corridor",
  },
  {
    id: 27,
    key: "future_busway_corridor",
    table: "qld_dams_state_transport_future_busway_corridor",
  },
  {
    id: 28,
    key: "busway_corridor",
    table: "qld_dams_state_transport_busway_corridor",
  },
  {
    id: 29,
    key: "future_light_rail_corridor",
    table: "qld_dams_state_transport_future_light_rail_corridor",
  },
  {
    id: 30,
    key: "light_rail_corridor",
    table: "qld_dams_state_transport_light_rail_corridor",
  },
  {
    id: 31,
    key: "state_controlled_road",
    table: "qld_dams_state_transport_state_controlled_road",
  },
  {
    id: 32,
    key: "future_state_controlled_road",
    table: "qld_dams_state_transport_future_state_controlled_road",
  },
  {
    id: 35,
    key: "future_railway_corridor",
    table: "qld_dams_state_transport_future_railway_corridor",
  },
  {
    id: 36,
    key: "railway_corridor",
    table: "qld_dams_state_transport_railway_corridor",
  },
];

const DEFAULT_DELAY_MS = Number(process.env.DAMS_IMPORT_DELAY_MS || 750);
const DEFAULT_PAGE_SIZE = Number(process.env.DAMS_IMPORT_PAGE_SIZE || 1000);
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
    delayMs: DEFAULT_DELAY_MS,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  for (const arg of argv) {
    if (arg.startsWith("--layer=")) {
      const v = Number(arg.slice("--layer=".length));
      if (Number.isFinite(v)) options.layerId = v;
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
        const jitter = Math.floor(Math.random() * 150);
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
      if (!retryable || attempt === retries) {
        throw err;
      }
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

async function fetchLayerMetadata(layerId, delayMs) {
  const url = `${MAPSERVER_BASE}/${layerId}`;
  return requestJson(url, {
    params: { f: "pjson" },
    delayMs,
  });
}

async function fetchLayerFeaturesPage({
  layerId,
  delayMs,
  offset,
  pageSize,
  orderByField,
}) {
  const url = `${MAPSERVER_BASE}/${layerId}/query`;
  return requestJson(url, {
    params: {
      where: "1=1",
      outFields: "*",
      f: "geojson",
      resultOffset: offset,
      resultRecordCount: pageSize,
      orderByFields: `${orderByField} ASC`,
    },
    delayMs,
  });
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

async function importLayer(client, layerConfig, options) {
  const { truncate, delayMs, pageSize } = options;
  const { id: layerId, table, key } = layerConfig;

  await ensureTable(client, table);
  if (truncate) {
    await client.query(`TRUNCATE TABLE ${quoteIdent(table)};`);
  }

  const layerMeta = await fetchLayerMetadata(layerId, delayMs);
  const layerName = layerMeta?.name || key;
  const maxRecordCount = Number(layerMeta?.maxRecordCount || 2000);
  const effectivePageSize = Math.max(1, Math.min(pageSize, maxRecordCount));
  const orderByField = getObjectIdFieldName(layerMeta);

  console.log(`\nLayer ${layerId}: ${layerName}`);
  console.log(
    `Table: ${table} | pageSize=${effectivePageSize} | orderBy=${orderByField}`
  );

  let offset = 0;
  let totalInserted = 0;
  let pageNumber = 0;
  let batch = [];
  const importedAt = new Date().toISOString();

  while (true) {
    const page = await fetchLayerFeaturesPage({
      layerId,
      delayMs,
      offset,
      pageSize: effectivePageSize,
      orderByField,
    });

    const features = Array.isArray(page?.features) ? page.features : [];
    if (!features.length) break;

    for (const feature of features) {
      if (!feature?.geometry) continue;

      const props = {
        ...(feature.properties || {}),
        __source: "qld_dams_state_transport",
        __source_layer_id: layerId,
        __source_layer_name: layerName,
        __imported_at: importedAt,
      };

      batch.push({
        props,
        geomJson: JSON.stringify(feature.geometry),
      });

      if (batch.length >= BATCH_SIZE) {
        totalInserted += await flushBatch(client, table, batch);
        batch = [];
      }
    }

    pageNumber += 1;
    process.stdout.write(
      `\r  pages=${String(pageNumber).padStart(4, " ")} inserted=${String(
        totalInserted + batch.length
      ).padStart(7, " ")}`
    );

    offset += features.length;
    if (features.length < effectivePageSize) break;
  }

  if (batch.length) {
    totalInserted += await flushBatch(client, table, batch);
  }

  process.stdout.write("\n");
  console.log(`✅ Imported ${totalInserted} features into ${table}`);
}

async function main() {
  const connectionString = requireEnv("DATABASE_URL");
  const options = parseArgs(process.argv.slice(2));

  const layers = options.layerId
    ? STATE_TRANSPORT_LAYERS.filter((l) => l.id === options.layerId)
    : STATE_TRANSPORT_LAYERS;

  if (!layers.length) {
    console.error(
      `Unknown --layer value. Valid IDs: ${STATE_TRANSPORT_LAYERS.map((l) => l.id).join(", ")}`
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
      `Starting DAMS State Transport import for ${layers.length} layer(s)...`
    );
    for (const layer of layers) {
      await importLayer(client, layer, options);
    }
    console.log("\nAll selected layers imported successfully.");
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
