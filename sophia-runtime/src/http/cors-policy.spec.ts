import { describe, expect, it } from "@jest/globals";
import { SOPHIA_CORS_ALLOWED_HEADERS } from "./cors-policy.js";

describe("Sophia Runtime CORS policy", () => {
  it("allows the server-authorised Admin tenant selector header", () => {
    expect(
      SOPHIA_CORS_ALLOWED_HEADERS.map((header) => header.toLowerCase()),
    ).toContain("x-sophia-admin-tenant-id");
  });
});
