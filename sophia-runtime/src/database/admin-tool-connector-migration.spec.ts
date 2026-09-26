import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("Admin tool and connector lifecycle migration", () => {
  it("links capability grants to connector authority and preserves disconnect reconciliation", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/017_admin_tool_connector_lifecycle.sql"), "utf8");
    expect(sql).toContain("connector_binding_id uuid");
    expect(sql).toContain("'disconnecting'");
    expect(sql).toContain("connector_binding_events");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("unresolved_command_count");
  });
});
