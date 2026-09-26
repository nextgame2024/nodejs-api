import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("agent authoring migration", () => {
  it("pins sessions and keeps manifests immutable with separate revocation", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "migrations/009_agent_authoring_and_releases.sql"),
      "utf8",
    );
    for (const table of [
      "agents", "instruction_sets", "instruction_revisions", "agent_drafts",
      "agent_release_manifests", "agent_release_revocations",
    ]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS __SOPHIA_RUNTIME_SCHEMA__.${table}`);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS agent_release_id");
    expect(sql).toContain("FOREIGN KEY (agent_release_id, customer_id)");
    expect(sql).toContain("A session release manifest pin is immutable");
    expect(sql).toContain("protect_agent_release_manifest");
    expect(sql).toContain("Approved instruction revisions are immutable");
    expect(sql).toContain("agent_release_revocations ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("agent_release_revocations FORCE ROW LEVEL SECURITY");
  });
});
