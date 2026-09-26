import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("provider operations migration", () => {
  it("adds isolated catalogs, cleanup leases, bounded sessions and event ownership additively", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/012_provider_operations.sql"),
      "utf8",
    );
    for (const fragment of [
      "provider_catalog_deployments", "provider_resource_owners", "provider_session_allocations",
      "cleanup_lease_until", "disconnect_expires_at", "hard_expires_at", "execution_owner",
      "operation_lease_until", "uq_sophia_tool_call_event_owner", "FORCE ROW LEVEL SECURITY",
    ]) expect(sql).toContain(fragment);
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM/i);
  });
});
