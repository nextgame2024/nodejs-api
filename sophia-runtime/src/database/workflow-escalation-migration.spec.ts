import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("Workflow and escalation control-plane migration", () => {
  it("pins immutable workflow versions and creates durable tenant-isolated escalation cases", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)),
      "migrations/018_workflow_and_escalation_control_plane.sql"), "utf8");
    expect(sql).toContain("workflow_versions");
    expect(sql).toContain("protect_workflow_run_pin");
    expect(sql).toContain("workflow_retry_commands");
    expect(sql).toContain("idempotency_key");
    expect(sql).toContain("Published workflow versions are immutable");
    expect(sql).toContain("escalation_case_events");
    expect(sql).toContain("delivery_status");
    expect(sql).toContain("transfer_status");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });
});
