import { describe, expect, jest, test } from "@jest/globals";

const query = jest.fn(async (sql) => {
  if (sql.includes("to_regclass('public.bm_xero_student_sync_runs')"))
    return { rows: [{ name: "bm_xero_student_sync_runs" }] };
  if (sql.includes("FROM bm_xero_student_sync_runs WHERE status IN"))
    return { rows: [] };
  if (sql.includes('INSERT INTO bm_xero_student_sync_config') || sql.includes('WITH due AS')) return { rows: [] };
  throw new Error(`Unexpected database query: ${sql}`);
});
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));
jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { connect },
}));
const { processSyncBatch } = await import(
  "../src/services/bm.studentUserSync.service.js"
);

describe("scheduled Student-user sync", () => {
  test("an idle worker checks durable schedules before processing runs", async () => {
    await processSyncBatch();
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).toContain('FOR UPDATE OF c SKIP LOCKED');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
