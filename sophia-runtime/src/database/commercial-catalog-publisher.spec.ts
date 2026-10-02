import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL(
  "../../scripts/publish-commercial-catalog.mts", import.meta.url)), "utf8");

describe("commercial catalog publisher", () => {
  it("accepts plan-specific usage, commitment and immutable charge components", () => {
    expect(source).toContain("includedActiveSeconds");
    expect(source).toContain("minimumCommitmentMonths");
    expect(source).toContain("chargeComponents");
    expect(source).toContain("commercial_plan_charge_components");
  });

  it("authors a new plan as draft, attaches components, then publishes atomically", () => {
    expect(source).toMatch(/VALUES\(\$1,\$2,\$3,'draft'/);
    expect(source).toContain("SET status='published',published_at=$2");
    expect(source.indexOf("commercial_plan_charge_components")).toBeLessThan(
      source.indexOf("SET status='published',published_at=$2"));
  });

  it("keeps legacy catalog manifests compatible when extended terms are omitted", () => {
    expect(source).toContain('plan.includedActiveSeconds ?? "120000"');
    expect(source).toContain("plan.minimumCommitmentMonths !== undefined");
    expect(source).toContain("differs from the requested immutable manifest");
  });
});
