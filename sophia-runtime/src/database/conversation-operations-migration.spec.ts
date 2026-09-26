import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("conversation operations migration", () => {
  it("links workflow runs and protects tenant-scoped operator notes", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/025_conversation_operations.sql"), "utf8");
    expect(sql).toContain("source_session_id");
    expect(sql).toContain("conversation_operator_notes");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("privacy redaction");
    expect(sql).toContain("REVOKE DELETE ON");
  });
});
