import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing Meter sandbox-clock migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/048_billing_meter_sandbox_clock.sql", import.meta.url,
  )), "utf8");

  it("keeps live events non-future while allowing only the bounded sandbox clock horizon", () => {
    expect(sql).toContain("provider_environment = 'live' AND event_timestamp <= created_at");
    expect(sql).toContain("provider_environment = 'sandbox'");
    expect(sql).toContain("event_timestamp <= created_at + interval '62 days'");
  });

  it("replaces the anonymous wall-clock-only constraint with a named contract", () => {
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS billing_meter_event_outbox_check1");
    expect(sql).toContain("billing_meter_event_outbox_event_timestamp_check");
  });
});
