import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("approved knowledge lifecycle migration", () => {
  it("creates tenant-isolated revisions, jobs, granted snapshots and search documents", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/015_approved_knowledge_lifecycle.sql"),
      "utf8",
    );
    for (const table of [
      "knowledge_sources", "knowledge_source_revisions", "knowledge_ingestion_jobs",
      "knowledge_snapshots", "knowledge_snapshot_grants", "knowledge_index_documents",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.${table}`);
    expect(sql).toContain("GENERATED ALWAYS AS (to_tsvector");
    expect(sql).toContain("protect_published_knowledge_revision");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|https?:\/\//i);
  });
});
