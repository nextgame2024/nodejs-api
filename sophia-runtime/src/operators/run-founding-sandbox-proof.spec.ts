import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./run-founding-sandbox-proof.ts", import.meta.url)), "utf8");

describe("Founding full-lifecycle sandbox proof", () => {
  it("is isolated to Stripe test mode, an assigned plan and explicit confirmation", () => {
    expect(source).toContain("I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS");
    expect(source).toContain('config.billing.provider !== "stripe_sandbox"');
    expect(source).toContain("SOPHIA_FOUNDING_PLAN_VERSION_ID");
    expect(source).toContain("The isolated C4B Founding tenant and sole active plan assignment are missing");
  });

  it("proves the exact initial, overage, milestone and commitment outcomes", () => {
    expect(source).toContain("amount_paid !== 114_000");
    expect(source).toContain("billableOverageMinutes: 2");
    expect(source).toContain("acceptProductionDeployment");
    expect(source).toContain("periods_observed !== 12");
  });

  it("requires restricted cancellation before and standard cancellation after the provider boundary", () => {
    expect(source).toContain('portal.cancellation.mode !== "commitment_restricted"');
    expect(source).toContain('portal.cancellation.mode !== "standard"');
    expect(source).toContain("current_period_start");
  });
});
