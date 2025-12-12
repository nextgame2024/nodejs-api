// scripts/import-property-parcels-to-postgis.mjs
// Usage:
//   DATABASE_URL=postgresql://... node scripts/import-property-parcels-to-postgis.mjs \
//     ./scripts/property-boundaries-parcel.json \
//     bcc_property_parcels

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import StreamArray from "stream-json/streamers/StreamArray.js";

const { Pool } = pg;

// --- Small helper so errors fail hard ---
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

// Batch insert helper
async function insertBatch(client, tableName, batch) {
  if (!batch.length) return 0;

  const valuesSql = [];
  const params = [];

  batch.forEach((row, i) => {
    const base = i * 2;
    valuesSql.push(
      `($${base + 1}::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($${base + 2}::text), 4326))`
    );
    params.push(JSON.stringify(row.props), JSON.stringify(row.geom));
  });

  const sql = `INSERT INTO ${tableName} (properties, geom)
               VALUES ${valuesSql.join(",")}`;

  await client.query(sql, params);
  return batch.length;
}

async function main() {
  const [, , jsonFilePath, tableName] = process.argv;

  if (!jsonFilePath || !tableName) {
    console.error(
      "Usage: node scripts/import-property-parcels-to-postgis.mjs <path-to-json> <table-name>"
    );
    process.exit(1);
  }

  const resolvedPath = path.resolve(jsonFilePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`JSON file not found at: ${resolvedPath}`);
    process.exit(1);
  }

  const databaseUrl = requireEnv("DATABASE_URL");

  console.log(`Importing parcels from: ${resolvedPath}`);
  console.log(`Target table: ${tableName}`);

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("neon.tech")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  const client = await pool.connect();

  try {
    // Ensure PostGIS and table exist
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id         bigserial PRIMARY KEY,
        properties jsonb      NOT NULL,
        geom       geometry(Geometry, 4326) NOT NULL
      );
    `);

    const readStream = fs.createReadStream(resolvedPath, { encoding: "utf8" });

    // StreamArray.withParser() expects a JSON array at the top level
    // e.g. [ { ...parcel1... }, { ...parcel2... }, ... ]
    const jsonStream = StreamArray.withParser();

    const BATCH_SIZE = 200;
    let batch = [];
    let total = 0;

    jsonStream.on("data", ({ value }) => {
      // value is one parcel object from the array
      const geomObj = value?.geo_shape?.geometry;
      if (!geomObj) {
        // No geometry – skip (we only want polygon parcels)
        return;
      }

      batch.push({ props: value, geom: geomObj });

      if (batch.length >= BATCH_SIZE) {
        // Pause the JSON stream while we flush this batch to DB
        jsonStream.pause();
        insertBatch(client, tableName, batch)
          .then((inserted) => {
            total += inserted;
            process.stdout.write(
              `\rInserted parcels: ${total.toString().padStart(7, " ")}`
            );
            batch = [];
            jsonStream.resume();
          })
          .catch((err) => {
            console.error("\nError inserting batch:", err);
            process.exit(1);
          });
      }
    });

    jsonStream.on("end", async () => {
      try {
        if (batch.length) {
          const inserted = await insertBatch(client, tableName, batch);
          total += inserted;
        }
        console.log(
          `\n✅ Finished importing ${total} parcels into ${tableName}`
        );
      } catch (err) {
        console.error("\nError inserting final batch:", err);
        process.exit(1);
      } finally {
        client.release();
        await pool.end();
      }
    });

    jsonStream.on("error", (err) => {
      console.error("Error while parsing JSON stream:", err);
      process.exit(1);
    });

    readStream.on("error", (err) => {
      console.error("Error reading JSON file:", err);
      process.exit(1);
    });

    // Start the pipeline
    readStream.pipe(jsonStream.input);
  } catch (err) {
    console.error("Fatal error during import:", err);
    client.release();
    await pool.end();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
