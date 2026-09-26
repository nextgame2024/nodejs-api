import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("commercial plan retirement migration", () => {
  it("permits only the lifecycle-only published-to-retired transition", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)),
      "migrations/029_commercial_plan_retirement.sql"), "utf8");
    expect(sql).toContain("NEW.status = 'retired'");
    expect(sql).toContain("to_jsonb(NEW) - 'status'");
    expect(sql).toContain("to_jsonb(OLD) - 'status'");
    expect(sql).toContain("OLD.status = 'retired'");
    expect(sql).toContain("Published commercial plan versions are immutable");
  });
});
