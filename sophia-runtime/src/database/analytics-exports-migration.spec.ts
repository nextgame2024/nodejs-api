import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("analytics exports migration", () => {
  it("stores a bounded aggregate snapshot and scrubs it on irreversible expiry", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "migrations/027_analytics_exports.sql"), "utf8");
    expect(sql).toContain("analytics_export_jobs");
    expect(sql).toContain("point_count BETWEEN 0 AND max_points");
    expect(sql).toContain("octet_length(document::text) <= 5242880");
    expect(sql).toContain("expiry scrubbing");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE DELETE ON");
  });
});
