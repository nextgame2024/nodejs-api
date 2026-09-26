import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminAuditService } from "./authorization/admin-audit.service.js";

describe("Sophia Admin foundation", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_RUNTIME_SCHEMA = "sophia_runtime";
  });

  it("references existing identities without duplicating credentials", async () => {
    const sql = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "../database/migrations/007_admin_authorization_foundation.sql"),
      "utf8",
    );
    expect(sql).toContain("identity_user_id text NOT NULL");
    expect(sql).toContain("UNIQUE (customer_id, identity_user_id)");
    expect(sql).not.toMatch(/CREATE TABLE[^;]*(?:users|identities)/i);
    expect(sql).not.toMatch(/(?:password|access_token|refresh_token|mfa_secret)\s+text/i);
  });

  it("redacts sensitive audit metadata before persistence", async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const audit = new AdminAuditService(database as never);
    await audit.record({
      eventType: "admin.test",
      outcome: "denied",
      metadata: {
        reason: "test",
        authorization: "Bearer secret",
        transcript: "private content",
        nested: { credential: "nested-secret", safe: "visible" },
      },
    });

    const params = database.query.mock.calls[0]?.[1] as unknown[];
    expect(params[8]).toBe(JSON.stringify({
      reason: "test",
      authorization: "[REDACTED]",
      transcript: "[REDACTED]",
      nested: { credential: "[REDACTED]", safe: "visible" },
    }));
  });
});
