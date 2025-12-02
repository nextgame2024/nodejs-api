// scripts/import-geojson-to-postgis.mjs
import axios from "axios";

// CommonJS modules: import default, then destructure
import pgPkg from "pg";
const { Client } = pgPkg;

import streamChainPkg from "stream-chain";
const { chain } = streamChainPkg;

import streamJsonPkg from "stream-json";
const { parser } = streamJsonPkg;

import pickPkg from "stream-json/filters/Pick.js";
const { pick } = pickPkg;

import streamArrayPkg from "stream-json/streamers/StreamArray.js";
const { streamArray } = streamArrayPkg;

// ---------- DB CONNECTION ----------

// Prefer DATABASE_URL, else build from DB_* vars
const connectionString =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST &&
    `postgres://${encodeURIComponent(
      process.env.DB_USER
    )}:${encodeURIComponent(process.env.DB_PASSWORD)}@${
      process.env.DB_HOST
    }:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE}`);

if (!connectionString) {
  console.error(
    "DATABASE_URL or DB_* env vars are required (DB_HOST, DB_USER, DB_PASSWORD, DB_DATABASE)."
  );
  process.exit(1);
}

// ---------- DATASET CONFIG ----------

const S3_BASE =
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public";

const DATASETS = {
  zoning: {
    url: `${S3_BASE}/cp14-zoning-overlay.geojson`,
    table: "bcc_zoning",
  },
  np_boundaries: {
    url: `${S3_BASE}/cp14-neighbourhood-plan-boundaries.geojson`,
    table: "bcc_np_boundaries",
  },
  np_precincts: {
    url: `${S3_BASE}/cp14-neighbourhood-plan-precincts.geojson`,
    table: "bcc_np_precincts",
  },
  flood_river: {
    url: `${S3_BASE}/cp14-flood-overlay-brisbane-river-flood-planning-area.geojson`,
    table: "bcc_flood_river",
  },
  flood_creek: {
    url: `${S3_BASE}/cp14-flood-overlay-creek-waterway-flood-planning-area.geojson`,
    table: "bcc_flood_creek",
  },
  flood_overland: {
    url: `${S3_BASE}/cp14-flood-overlay-overland-flow.geojson`,
    table: "bcc_flood_overland",
  },
  noise_corridor: {
    url: `${S3_BASE}/cp14-transport-noise-corridor-overlay.geojson`,
    table: "bcc_noise_corridor",
  },
};

// Tune if needed
const BATCH_SIZE = 200;

// ---------- IMPORTER ----------

async function importDataset(key) {
  const cfg = DATASETS[key];
  if (!cfg) {
    console.error(
      `Unknown dataset "${key}". Use one of: ${Object.keys(DATASETS).join(
        ", "
      )}`
    );
    process.exit(1);
  }

  console.log(`Importing ${cfg.url} into ${cfg.table} ...`);

  const client = new Client({ connectionString });
  await client.connect();

  let batch = [];
  let count = 0;

  async function flushBatch() {
    if (!batch.length) return;

    const values = [];
    const rowsSql = batch
      .map((row, idx) => {
        const p1 = idx * 2 + 1;
        const p2 = idx * 2 + 2;
        values.push(row.props, row.geomJson);
        return `($${p1}, ST_SetSRID(ST_GeomFromGeoJSON($${p2}), 4326))`;
      })
      .join(",");

    const sql = `INSERT INTO ${cfg.table} (properties, geom) VALUES ${rowsSql};`;

    await client.query(sql, values);
    count += batch.length;
    console.log(`  Inserted ${count} features so far into ${cfg.table} ...`);
    batch = [];
  }

  // Stream from S3 → stream-json → features
  const response = await axios.get(cfg.url, { responseType: "stream" });

  const pipeline = chain([
    response.data,
    parser(),
    pick({ filter: "features" }),
    streamArray(),
  ]);

  try {
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
    console.log(`✅ Finished importing ${count} features into ${cfg.table}`);
  } catch (err) {
    console.error("❌ Error while importing:", err);
  } finally {
    await client.end();
  }
}

// ---------- CLI ENTRY ----------

const datasetKey = process.argv[2];
if (!datasetKey) {
  console.error(
    `Usage: node scripts/import-geojson-to-postgis.mjs <dataset-key>\n` +
      `Where <dataset-key> is one of: ${Object.keys(DATASETS).join(", ")}`
  );
  process.exit(1);
}

importDataset(datasetKey).catch((e) => {
  console.error(e);
  process.exit(1);
});
