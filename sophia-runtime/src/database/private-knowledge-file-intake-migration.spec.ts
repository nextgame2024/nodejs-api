import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("private knowledge file intake migration", () => {
  it("adds durable bounded tenant-isolated file intake state", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/016_private_knowledge_file_intake.sql"), "utf8");
    for (const fragment of [
      "knowledge_file_intakes", "awaiting_upload", "quarantined", "declared_sha256_base64",
      "attempt_count", "lease_owner", "knowledge_revision_id", "FORCE ROW LEVEL SECURITY",
      "knowledge_file_intakes_tenant_isolation",
    ]) expect(sql).toContain(fragment);
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|https?:\/\//i);
  });
});
