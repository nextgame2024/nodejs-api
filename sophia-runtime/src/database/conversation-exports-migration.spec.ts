import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("conversation exports migration", () => {
  it("stores only tenant-scoped expiring manifests and immutable access evidence", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/026_conversation_exports.sql"), "utf8");
    expect(sql).toContain("conversation_export_jobs");
    expect(sql).toContain("export_scope IN ('metadata', 'content')");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("Conversation export job identity is immutable");
    expect(sql).toContain("REVOKE DELETE ON");
    expect(sql).not.toContain("document jsonb");
  });
});
