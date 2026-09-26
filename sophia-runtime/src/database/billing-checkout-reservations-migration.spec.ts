import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("billing Checkout reservation migration", () => {
  const sql = readFileSync(fileURLToPath(new URL("./migrations/034_billing_checkout_reservations.sql", import.meta.url)), "utf8");

  it("reserves one active provider allocation before external I/O", () => {
    expect(sql).toContain("'allocating'");
    expect(sql).toContain("'outcome_unknown'");
    expect(sql).toContain("uq_active_billing_checkout_intent");
    expect(sql).toContain("WHERE status IN ('allocating','outcome_unknown','created')");
  });

  it("allows only allocation recovery and one-way completion", () => {
    expect(sql).toContain("OLD.status IN ('allocating','outcome_unknown') AND NEW.status = 'created'");
    expect(sql).toContain("OLD.status = 'allocating' AND NEW.status = 'outcome_unknown'");
    expect(sql).toContain("OLD.status = 'created' AND NEW.status IN ('completed','expired')");
  });
});
