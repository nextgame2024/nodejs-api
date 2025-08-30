import mysql from "mysql2/promise";

const {
  // Option A: single URL (recommended for PlanetScale)
  DATABASE_URL, // e.g. mysql://user:pass@host:3306/dbname
  MYSQL_URL, // alt name if you prefer

  // Option B: discrete params (typical cPanel / RDS)
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,

  // Optional tunables
  DB_POOL_SIZE, // default 5
  DB_CONNECT_TIMEOUT, // default 15000 ms
  DB_SSL, // 'true' to enable TLS
  DB_SSL_REJECT_UNAUTH, // default true; set 'false' for self-signed
} = process.env;

function bool(v, def = false) {
  if (v === undefined) return def;
  return String(v).toLowerCase() === "true";
}

const poolSize = Number(DB_POOL_SIZE || 5);
const connectTimeout = Number(DB_CONNECT_TIMEOUT || 15000);
const useSSL = bool(DB_SSL, false);
const rejectUnauth = bool(DB_SSL_REJECT_UNAUTH, true);

let pool;

if (DATABASE_URL || MYSQL_URL) {
  const url = DATABASE_URL || MYSQL_URL;
  pool = mysql.createPool(url, {
    waitForConnections: true,
    connectionLimit: poolSize,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout,
    ssl: useSSL ? { rejectUnauthorized: rejectUnauth } : undefined,
  });
} else {
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    throw new Error(
      "DB config missing. Provide DATABASE_URL (or MYSQL_URL) OR DB_HOST, DB_USER, DB_PASSWORD, DB_NAME."
    );
  }
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
    ssl: useSSL ? { rejectUnauthorized: rejectUnauth } : undefined,
  });
}

// Health probe for startup/diag
export async function pingDb() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

export default pool;
