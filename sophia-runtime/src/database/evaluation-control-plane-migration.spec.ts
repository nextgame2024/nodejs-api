import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("evaluation control-plane migration", () => {
  it("pins deterministic evidence, forces tenant isolation and makes runs immutable", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/021_evaluation_control_plane.sql"), "utf8");
    expect(sql).toContain("evaluation_datasets");
    expect(sql).toContain("evaluation_dataset_versions");
    expect(sql).toContain("agent_evaluation_requirements");
    expect(sql).toContain("evaluation_runs");
    expect(sql).toContain("evidence_mode text NOT NULL CHECK (evidence_mode = 'deterministic')");
    expect(sql).toContain("external_effects boolean NOT NULL DEFAULT false CHECK (external_effects = false)");
    expect(sql).toContain("metered_session_created boolean NOT NULL DEFAULT false CHECK (metered_session_created = false)");
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(4);
    expect(sql).toContain("protect_evaluation_run BEFORE UPDATE OR DELETE");
    expect(sql).toContain("protect_evaluation_version_delete BEFORE DELETE");
    expect(sql).toContain("REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs FROM sophia_runtime_app");
    expect(sql).toContain("GRANT SELECT, INSERT ON __SOPHIA_RUNTIME_SCHEMA__.evaluation_runs TO sophia_runtime_app");
  });
});
