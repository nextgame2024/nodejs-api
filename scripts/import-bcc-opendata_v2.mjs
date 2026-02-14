// scripts/import-bcc-opendata_v2.mjs
//
// Imports Brisbane Open Data (Opendatasoft) datasets into PostGIS.
//
// Usage:
//   DATABASE_URL=postgresql://... node import-bcc-opendata_v2.mjs <dataset-key> [--truncate]
//
// Example:
//   DATABASE_URL=postgresql://... node import-bcc-opendata_v2.mjs traditional_character --truncate
//
// Implementation details:
// - Uses Opendatasoft Explore API v2.1 export endpoint to download full GeoJSON.
// - Streams the GeoJSON and inserts features in batches.
// - Ensures PostGIS + target table exist (standard schema: id, properties jsonb, geom geometry).

import axios from "axios";
import pg from "pg";
import streamChainPkg from "stream-chain";
import streamJsonPkg from "stream-json";
import pickPkg from "stream-json/filters/Pick.js";
import streamArrayPkg from "stream-json/streamers/StreamArray.js";
import "dotenv/config";

const { Client } = pg;
const { chain } = streamChainPkg;
const { parser } = streamJsonPkg;
const { pick } = pickPkg;
const { streamArray } = streamArrayPkg;

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

const PORTAL_BASE = "https://data.brisbane.qld.gov.au";

// Recommended new layers to better match your reference PDF.
// You can extend this list at will.
//
// Each entry maps to an Opendatasoft dataset identifier and your PostGIS table name.
const DATASETS = {
  // Character / heritage (high-visibility in reports)
  dwelling_house_character: {
    odsId: "cp14-dwelling-house-character-overlay",
    table: "bcc_dwelling_house_character",
  },
  traditional_character: {
    odsId: "cp14-traditional-building-character-overlay",
    table: "bcc_traditional_building_character",
  },
  commercial_character: {
    odsId: "cp14-commercial-character-building-overlay",
    table: "bcc_commercial_character_building",
  },
  pre_1911: {
    odsId: "cp14-pre-1911-building-overlay",
    table: "bcc_pre_1911_building",
  },
  heritage_state_heritage_area: {
    odsId: "cp14-heritage-overlay-state-heritage-area",
    table: "bcc_heritage_state_heritage_area",
  },

  // Building height constraints that are explicitly mapped (airport environs)
  airport_height_restriction: {
    odsId: "cp14-airport-environs-overlay-height-restriction-zone",
    table: "bcc_airport_height_restriction",
  },
  airport_ols_boundary: {
    odsId:
      "cp14-airport-environs-overlay-obstacle-limitation-surfaces-ols-boundary",
    table: "bcc_airport_ols_boundary",
  },

  // LGIP / services (proxy for service / trunk considerations)
  lgip_network_key: {
    odsId: "cp14-lgip-network-key",
    table: "bcc_lgip_network_key",
  },
  bicycle_network_overlay: {
    odsId: "cp14-bicycle-network-overlay",
    table: "bcc_bicycle_network_overlay",
  },
  critical_infrastructure_movement_assets: {
    odsId: "cp14-critical-infrastructure-movement-network-overlay-assets-infrastructure-move",
    table: "bcc_critical_infrastructure_movement_assets",
  },
  road_hierarchy_overlay: {
    odsId: "cp14-road-hierarchy-overlay-road-hierarchy",
    table: "bcc_road_hierarchy",
  },
  streetscape_hierarchy_overlay: {
    odsId: "cp14-streetscape-hierarchy-overlay-streetscape-hierarchy",
    table: "bcc_streetscape_hierarchy",
  },
  airport_pans_ops: {
    odsId:
      "cp14-airport-environs-overlay-procedures-for-air-nav-services-aircraft-operation",
    table: "bcc_airport_pans_ops",
  },
};

function odsGeoJsonExportUrl(odsId) {
  // Opendatasoft Explore API v2.1 export endpoint.
  // The API console for Brisbane Open Data is available at:
  //   https://data.brisbane.qld.gov.au/api/explore/v2.1/console
  const tz = encodeURIComponent("Australia/Brisbane");
  return `${PORTAL_BASE}/api/explore/v2.1/catalog/datasets/${encodeURIComponent(
    odsId
  )}/exports/geojson?lang=en&timezone=${tz}`;
}

async function ensureTable(client, tableNameRaw) {
  const tableName = quoteIdent(tableNameRaw);

  await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id         bigserial PRIMARY KEY,
      properties jsonb      NOT NULL DEFAULT '{}'::jsonb,
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

async function importOdsDataset({ odsId, table }, { truncate }) {
  const connectionString = requireEnv("DATABASE_URL");

  const client = new Client({
    connectionString,
    ssl: connectionString.includes("neon.tech")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  await client.connect();

  const url = odsGeoJsonExportUrl(odsId);
  console.log(`Importing ODS dataset: ${odsId}`);
  console.log(`From: ${url}`);
  console.log(`Into: ${table}`);

  const BATCH_SIZE = 250;
  let batch = [];
  let count = 0;

  try {
    await ensureTable(client, table);

    if (truncate) {
      await client.query(`TRUNCATE TABLE ${quoteIdent(table)};`);
      console.log(`Truncated ${table}`);
    }

    const response = await axios.get(url, { responseType: "stream" });

    const pipeline = chain([
      response.data,
      parser(),
      pick({ filter: "features" }),
      streamArray(),
    ]);

    async function flushBatch() {
      if (!batch.length) return;

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
      count += batch.length;
      process.stdout.write(
        `\rInserted ${count.toString().padStart(8, " ")} features into ${table}`
      );
      batch = [];
    }

    for await (const { value: feature } of pipeline) {
      if (!feature || !feature.geometry) continue;

      batch.push({
        props: feature.properties || {},
        geomJson: JSON.stringify(feature.geometry),
      });

      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
      }
    }

    await flushBatch();
    console.log(`\n✅ Finished importing ${count} features into ${table}`);
  } catch (err) {
    console.error(`\n❌ Import failed for ${odsId} -> ${table}`);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function main() {
  const [, , datasetKey, ...rest] = process.argv;

  if (!datasetKey) {
    console.error(
      `Usage: node import-bcc-opendata_v2.mjs <dataset-key> [--truncate]\n` +
        `Where <dataset-key> is one of: ${Object.keys(DATASETS).join(", ")}`
    );
    process.exit(1);
  }

  const cfg = DATASETS[datasetKey];
  if (!cfg) {
    console.error(
      `Unknown dataset-key "${datasetKey}". Use one of: ${Object.keys(
        DATASETS
      ).join(", ")}`
    );
    process.exit(1);
  }

  const truncate = rest.includes("--truncate") || rest.includes("-t");
  await importOdsDataset(cfg, { truncate });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
