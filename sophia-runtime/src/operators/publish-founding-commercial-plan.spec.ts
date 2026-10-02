import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./publish-founding-commercial-plan.ts", import.meta.url)), "utf8");

describe("Founding commercial-plan publisher", () => {
  it("uses the compiled production operator path and explicit publication confirmation", () => {
    expect(source).toContain("I_UNDERSTAND_THIS_PUBLISHES_A_COMMERCIAL_PLAN");
    expect(source).toContain("SOPHIA_RUNTIME_DATABASE_URL is required");
    expect(source).toContain("provider_environment='sandbox'");
  });

  it("publishes the exact approved immutable commercial facts", () => {
    expect(source).toContain('baseChargeMinor: "19000"');
    expect(source).toContain('includedActiveSeconds: "60000"');
    expect(source).toContain("minimumCommitmentMonths: 12");
    expect(source).toContain('amountMinor: "95000"');
    expect(source).toContain("production-deployment");
  });

  it("authors components while draft and validates exact state on rerun", () => {
    const insert = source.indexOf("INSERT INTO ${schema}.commercial_plan_versions");
    const component = source.indexOf("INSERT INTO ${schema}.commercial_plan_charge_components");
    const publish = source.indexOf("SET status='published'");
    expect(insert).toBeGreaterThan(-1);
    expect(component).toBeGreaterThan(insert);
    expect(publish).toBeGreaterThan(component);
    expect(source).toContain('result: "published" | "existing"');
  });
});
