import { describe, expect, jest, test } from "@jest/globals";

const query = jest.fn(async (sql) => {
  if (sql.includes("to_regclass('public.bm_xero_student_sync_runs')"))
    return { rows: [{ name: "bm_xero_student_sync_runs" }] };
  if (sql.includes("FROM bm_xero_student_sync_runs WHERE status IN"))
    return { rows: [] };
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

describe("manual-only Student-user sync", () => {
  test("an idle worker never scans configuration or queues a run", async () => {
    await processSyncBatch();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toContain(
      "bm_xero_student_sync_config",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
