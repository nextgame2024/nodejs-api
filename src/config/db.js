import pg from "pg";
const { Pool } = pg;

const { DATABASE_URL, DB_POOL_SIZE, DB_SSL, DB_CONNECT_TIMEOUT } = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required (Neon connection string).");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(DB_POOL_SIZE || 10),
  ssl:
    String(DB_SSL || "false").toLowerCase() === "true"
      ? { rejectUnauthorized: true }
      : undefined,
  statement_timeout: Number(DB_CONNECT_TIMEOUT || 30000),
  connectionTimeoutMillis: Number(DB_CONNECT_TIMEOUT || 30000),
});

export async function pingDb() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

export default pool;
