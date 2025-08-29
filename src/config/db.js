import mysql from "mysql2/promise";

const {
  // Option A: single connection string (preferred)
  DATABASE_URL, // e.g. mysql://user:pass@host:3306/dbname
  MYSQL_URL, // alt name if you prefer

  // Option B: discrete params
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,

  // Optional tunables
  DB_POOL_SIZE, // default 5
  DB_CONNECT_TIMEOUT, // default 10000 ms
  DB_SSL, // 'true' to enable SSL; default is false
} = process.env;

function bool(v, def = false) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === "true";
}

const useSSL = bool(DB_SSL, false);
const poolSize = Number(DB_POOL_SIZE || 5);
const connectTimeout = Number(DB_CONNECT_TIMEOUT || 10000);

let pool;

if (DB_HOST || DB_USER || DB_NAME) {
  // mysql2 accepts a URL string + options
  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT || 3306),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: poolSize,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout,
    ssl: useSSL ? { rejectUnauthorized: true } : undefined,
  });
} else {
  // Discrete env vars path
  if (!DATABASE_URL || !MYSQL_URL) {
    throw new Error(
      "DB config missing. Provide DATABASE_URL (or MYSQL_URL) OR DB_HOST, DB_USER, DB_PASSWORD, DB_NAME."
    );
  }
  // Connection string path
  const url = DATABASE_URL || MYSQL_URL;

  // mysql2 accepts a URL string + options
  pool = mysql.createPool(url, {
    waitForConnections: true,
    connectionLimit: poolSize,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout,
    ssl: useSSL ? { rejectUnauthorized: true } : undefined,
  });
}

// quick probe for health checks / startup gate
export async function pingDb() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

export default pool;
