import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("session activity intervals migration", () => {
  const sql = readFileSync(fileURLToPath(new URL(
    "./migrations/041_session_activity_intervals.sql",
    import.meta.url,
  )), "utf8");

  it("separates connected activity from operational session lifetime", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.session_activity_intervals");
    expect(sql).toContain("connection_id uuid NOT NULL");
    expect(sql).toContain("last_confirmed_at timestamptz NOT NULL");
    expect(sql).toContain("UNIQUE (session_id, connection_id)");
    expect(sql).toContain("WHERE status = 'open'");
    expect(sql).not.toContain("sessions.started_at");
  });

  it("makes finalised activity immutable and tenant isolated", () => {
    expect(sql).toContain("Finalised session activity is immutable");
    expect(sql).toContain("Session activity confirmation cannot move backwards");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("current_setting('sophia.tenant_id', true)");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE");
    expect(sql).not.toMatch(/GRANT[^;]*(DELETE|TRUNCATE)/);
  });
});
