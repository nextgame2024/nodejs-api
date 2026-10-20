import { describe, expect, it } from "@jest/globals";
import { SOPHIA_CORS_ALLOWED_HEADERS, SOPHIA_CORS_EXPOSED_HEADERS } from "./cors-policy.js";

describe("Sophia Runtime CORS policy", () => {
  it("allows the server-authorised Admin tenant selector header", () => {
    expect(
      SOPHIA_CORS_ALLOWED_HEADERS.map((header) => header.toLowerCase()),
    ).toContain("x-sophia-admin-tenant-id");
  });
  it("allows idempotent case updates from the browser", () => {
    expect(SOPHIA_CORS_ALLOWED_HEADERS.map((header) => header.toLowerCase())).toContain("idempotency-key");
  });
  it('allows browser request correlation and exposes response timing headers', () => {
    expect(SOPHIA_CORS_ALLOWED_HEADERS).toContain('X-Correlation-ID');
    expect(SOPHIA_CORS_EXPOSED_HEADERS).toEqual(['X-Correlation-ID', 'Server-Timing']);
  });
});
