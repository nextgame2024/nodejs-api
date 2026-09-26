import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("v2 canary orchestration migration", () => {
  it("adds one-time bootstrap grants and immutable version-pinned session snapshots additively", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/013_v2_canary_orchestration.sql"),
      "utf8",
    );
    for (const fragment of [
      "runtime_bootstrap_grants", "runtime_api_version", "experience_profile_version_id",
      "agent_release_id IS NOT NULL", "session_plan_snapshot", "session_plan_digest",
      "protect_session_v2_snapshot", "FORCE ROW LEVEL SECURITY",
    ]) expect(sql).toContain(fragment);
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM/i);
  });
});
