import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing meter-event outbox contract migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/045_billing_meter_event_outbox_contract.sql", import.meta.url,
  )), "utf8");

  it("permits submission start and renewal only while the fenced lease is live", () => {
    expect(sql.match(/OLD\.lease_until > now\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain("NEW.lease_token = OLD.lease_token");
    expect(sql).toContain("NEW.submission_started_at IS NULL");
  });
});
