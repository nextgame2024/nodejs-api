import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("safe tool execution migration", () => {
  it("adds canonical command identity, complete outcomes and tenant RLS additively", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/014_safe_tool_execution_pipeline.sql"),
      "utf8",
    );
    for (const fragment of [
      "canonical_tool_id", "capability_binding_id", "command_id", "provenance",
      "attempt_count", "outcome_unknown", "uq_sophia_tool_command_execution",
      "tool_calls_tenant_isolation", "action_reviews_tenant_isolation", "FORCE ROW LEVEL SECURITY",
    ]) expect(sql).toContain(fragment);
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM/i);
  });
});
