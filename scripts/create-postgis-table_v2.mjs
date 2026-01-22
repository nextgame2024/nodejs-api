// scripts/create-postgis-table_v2.mjs
// Usage:
//   DATABASE_URL=postgresql://... node create-postgis-table_v2.mjs <table-name>
//
// Creates a standard PostGIS table for spatial feature layers.

import pg from "pg";
const { Client } = pg;

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var ${name}. Example:`);
    console.error(`  export ${name}='postgresql://user:pass@host:5432/db?sslmode=require'`);
    process.exit(1);
  }
  return val;
}

function quoteIdent(ident) {
  // Minimal identifier quoting.
  // We still recommend using safe, fixed table names (no user input from web requests).
  return '"' + String(ident).replace(/"/g, '""') + '"';
}

async function main() {
  const [, , tableNameRaw] = process.argv;
  if (!tableNameRaw) {
    console.error("Usage: node create-postgis-table_v2.mjs <table-name>");
    process.exit(1);
  }

  const connectionString = requireEnv("DATABASE_URL");
  const tableName = quoteIdent(tableNameRaw);

  const client = new Client({
    connectionString,
    ssl: connectionString.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id         bigserial PRIMARY KEY,
        properties jsonb      NOT NULL DEFAULT '{}'::jsonb,
        geom       geometry(Geometry, 4326) NOT NULL
      );
    `);

    // Spatial index
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(tableNameRaw + "__geom_gist")} ON ${tableName} USING GIST (geom);`
    );

    // Properties index (helps simple key lookups)
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(tableNameRaw + "__props_gin")} ON ${tableName} USING GIN (properties);`
    );

    console.log(`✅ Ensured table + indexes exist: ${tableNameRaw}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
