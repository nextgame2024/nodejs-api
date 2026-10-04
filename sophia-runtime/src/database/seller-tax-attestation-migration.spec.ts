import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("seller tax attestation migration", () => {
  it("stores narrow append-only evidence behind a current-attestation function", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)),
      "migrations/056_seller_tax_attestations.sql"), "utf8");
    expect(sql).toContain("gst_registration_threshold_minor = 7500000");
    expect(sql).toContain("projection_months = 12");
    expect(sql).toContain("review_due_at <= attested_at + interval '31 days'");
    expect(sql).toContain("Seller tax attestation evidence is append-only");
    expect(sql).toContain("latest_current_seller_tax_attestation");
    expect(sql).toContain("REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.seller_tax_attestations FROM sophia_runtime_app");
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*seller_tax_attestations/);
  });
});
