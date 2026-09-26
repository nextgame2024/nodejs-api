import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { UnauthorizedException } from "@nestjs/common";
import { BusinessManagerIdentityBridge } from "./business-manager-identity.bridge.js";

describe("BusinessManagerIdentityBridge", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.BUSINESS_MANAGER_API_URL = "https://business-manager.example/api";
    jest.restoreAllMocks();
  });

  it("forwards the existing access token and accepts an active tenant-bound identity", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      user: {
        id: "user-1",
        companyId: "33333333-3333-4333-8333-333333333333",
        status: "active",
        email: "Person@Example.com",
      },
    }), { status: 200 }));
    const bridge = new BusinessManagerIdentityBridge();

    await expect(bridge.authenticate("Token signed-existing-token")).resolves.toEqual({
      userId: "user-1",
      companyId: "33333333-3333-4333-8333-333333333333",
      status: "active",
      email: "person@example.com",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://business-manager.example/api/user",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Token signed-existing-token" }) }),
    );
  });

  it("does not accept runtime credentials when identity verification fails", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    const bridge = new BusinessManagerIdentityBridge();
    await expect(bridge.authenticate("Bearer opaque-runtime-session-token"))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});
