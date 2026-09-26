import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { readFile } from "node:fs/promises";

const query = jest.fn();
jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { query, connect: jest.fn() },
}));
const workerModel = await import("../src/models/bm.propertyReportWorker.model.js");

describe("inspection workflow hardening", () => {
  beforeEach(() => query.mockReset());
  it("fences report lease renewal with the unique claim token and live lease", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(workerModel.renewLease({
      reportJobId: "30000000-0000-4000-8000-000000000001",
      workerId: "worker-1",
      claimToken: "40000000-0000-4000-8000-000000000001",
      leaseSeconds: 60,
    })).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain("claim_token = $4 AND lease_until > now()");
    expect(query.mock.calls[0][1]).toEqual([
      "30000000-0000-4000-8000-000000000001", "worker-1", 60,
      "40000000-0000-4000-8000-000000000001",
    ]);
  });

  it("does not auto-retry an expired delivery whose provider outcome may be unknown", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(workerModel.recoverExpiredDeliveries()).resolves.toBe(1);
    expect(query.mock.calls[0][0]).toContain("SET status = 'outcome_unknown'");
    expect(query.mock.calls[0][0]).not.toContain("'email_retry'");
  });

  it("declares honest provider milestones and fencing columns in the additive schema", async () => {
    const source = await readFile(new URL("../src/config/startupMigrations.js", import.meta.url), "utf8");
    expect(source).toContain("claim_generation integer NOT NULL DEFAULT 0");
    expect(source).toContain("'provider_accepted'");
    expect(source).toContain("'previewed'");
    expect(source).toContain("'outcome_unknown'");
    expect(source).toContain("verified_delivered_at");
    const reportTable = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS bm_property_report_jobs"),
      source.indexOf("CREATE INDEX IF NOT EXISTS idx_bm_property_report_jobs_claim"));
    const deliveryTable = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS bm_inspection_confirmation_deliveries"),
      source.indexOf("CREATE INDEX IF NOT EXISTS idx_bm_inspection_deliveries_claim"));
    expect(reportTable).not.toContain("session_id");
    expect(deliveryTable).not.toContain("session_id");
  });
});
