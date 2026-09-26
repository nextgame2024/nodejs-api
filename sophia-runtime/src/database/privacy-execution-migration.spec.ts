import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("privacy execution migration", () => {
  it("makes execution evidence tenant-isolated, append-only and hold-aware", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/024_privacy_execution.sql"), "utf8");
    expect(sql).toContain("privacy_subject_bindings");
    expect(sql).toContain("privacy_subject_request_events");
    expect(sql).toContain("privacy_retention_runs");
    expect(sql).toContain("unsafe_cleanup_count");
    expect(sql).toContain("Privacy request events are append-only");
    expect(sql).toContain("Privacy retention run evidence is immutable");
    expect(sql).toContain("Verified privacy request target evidence is immutable");
    expect(sql).toContain("Privacy lifecycle evidence cannot be deleted");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE DELETE ON");
  });
});
