import { describe, expect, it, jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import { V2SessionService } from "./v2-session.service.js";
import { assertFallbackDataPolicy } from "./v2-session-plan.resolver.js";

describe("v2 session allocation boundary", () => {
  it("rejects an unsupported published composition before any paid allocation", async () => {
    const bootstrap = { redeem: jest.fn().mockResolvedValue({
      bootstrapId: "33333333-3333-4333-8333-333333333333",
      customerId: "11111111-1111-4111-8111-111111111111",
      experienceId: "custom", deviceId: "22222222-2222-4222-8222-222222222222",
    }) };
    const plans = { resolve: jest.fn().mockRejectedValue(new UnprocessableEntityException({
      code: "UNSUPPORTED_COMPOSITION", reasons: ["PROVIDER_COMPOSITION_UNSUPPORTED"],
    })) };
    const operations = { begin: jest.fn(), open: jest.fn() };
    const service = new V2SessionService(
      {} as never, {} as never, operations as never, bootstrap as never, plans as never,
    );

    await expect(service.create({ experienceId: "custom", deviceId: "22222222-2222-4222-8222-222222222222" }, "grant"))
      .rejects.toMatchObject({ response: { code: "UNSUPPORTED_COMPOSITION" } });
    expect(operations.begin).not.toHaveBeenCalled();
    expect(operations.open).not.toHaveBeenCalled();
  });

  it("rejects recording or full-transcript persistence before any paid allocation", async () => {
    const bootstrap = { redeem: jest.fn().mockResolvedValue({
      bootstrapId: "33333333-3333-4333-8333-333333333333",
      customerId: "11111111-1111-4111-8111-111111111111",
      experienceId: "custom", deviceId: "22222222-2222-4222-8222-222222222222",
    }) };
    const plans = { resolve: jest.fn().mockResolvedValue({
      profile: { plan: { dataPolicy: { transcriptPersistence: "enabled", audioPersistence: "enabled" } } },
    }) };
    const operations = { begin: jest.fn(), open: jest.fn() };
    const service = new V2SessionService(
      {} as never, {} as never, operations as never, bootstrap as never, plans as never,
    );

    await expect(service.create({ experienceId: "custom", deviceId: "22222222-2222-4222-8222-222222222222" }, "grant"))
      .rejects.toThrow("without a session consent activation path");
    expect(operations.begin).not.toHaveBeenCalled();
    expect(operations.open).not.toHaveBeenCalled();
  });

  it("keeps provider fallback disabled until equivalent data handling is verified", () => {
    try {
      assertFallbackDataPolicy({ mode: "pre-session-only", allowedProfileVersions: ["fallback-v1"] });
      throw new Error("Expected fallback rejection");
    } catch (error) {
      expect(error).toMatchObject({ response: { reasons: ["FALLBACK_DATA_POLICY_UNVERIFIED"] } });
    }
    expect(() => assertFallbackDataPolicy({ mode: "none", allowedProfileVersions: [] })).not.toThrow();
  });
});
