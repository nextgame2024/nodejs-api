import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@jest/globals";

const sql = readFileSync(fileURLToPath(new URL(
  "./migrations/046_provider_capacity_and_tool_admission_classes.sql", import.meta.url)), "utf8");

describe("provider capacity and tool admission migration", () => {
  it("adds independent tool/class dimensions and a provider-neutral global capacity count", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS tool_id");
    expect(sql).toContain("admission_class IN ('read-search','mutation','sensitive')");
    expect(sql).toContain("provider_session_capacity_occupied");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION");
  });
});
