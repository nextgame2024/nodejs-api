import { afterAll, expect, it, jest } from "@jest/globals";
import pg from "pg";

// Opt-in PostgreSQL regression check. EXPLAIN (without ANALYZE) validates the
// real claim query against the schema without claiming work or sending email.
const database = process.env.INSPECTION_SQL_TEST_DATABASE === "1"
  ? new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 10_000,
  })
  : null;
const deliveryId = "00000000-0000-4000-8000-000000000000";
const release = jest.fn();
const plans = [];
const query = jest.fn(async (sql, values) => {
  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
  const result = await database.query(`EXPLAIN ${sql}`, values);
  plans.push(result.rows);
  if (sql.trimStart().startsWith("SELECT")) {
    return { rows: [{ delivery_id: deliveryId }] };
  }
  return { rows: [] };
});
jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { connect: async () => ({ query, release }) },
}));
const { claimNextDelivery } = await import("../src/models/bm.propertyReportWorker.model.js");
afterAll(async () => { await database?.end(); });

(database ? it : it.skip)("PostgreSQL accepts the complete joined email claim query", async () => {
  await expect(claimNextDelivery({ workerId: "sql-validation-only", leaseSeconds: 300 }))
    .resolves.toBeNull();
  expect(plans).toHaveLength(2);
  expect(release).toHaveBeenCalledTimes(1);
});
