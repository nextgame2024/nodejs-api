import { describe, expect, it } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("billing authorization proof migration", () => {
  it("stores only append-only bounded proof evidence behind narrow functions", async () => {
    const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)),
      "migrations/055_billing_authorization_proofs.sql"), "utf8");
    expect(sql).toContain("permission_key = 'billing.manage'");
    expect(sql).toContain("requested_mfa_verified_at < now() - interval '12 hours'");
    expect(sql).toContain("Billing authorization proof evidence is append-only");
    expect(sql).toContain("latest_billing_authorization_proof()");
    expect(sql).toContain("REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.billing_authorization_proofs FROM sophia_runtime_app");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION __SOPHIA_RUNTIME_SCHEMA__.record_billing_authorization_proof");
    expect(sql).not.toMatch(/stripe|invoice|subscription|checkout|charge/i);
  });
});
