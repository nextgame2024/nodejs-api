import { beforeEach, describe, expect, it } from "@jest/globals";
import { SimliAvatarProvider } from "./simli-avatar.provider.js";

describe("SimliAvatarProvider", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    delete process.env.SIMLI_API_KEY;
  });

  it("creates a provider-neutral mock avatar session without real credentials", async () => {
    const provider = new SimliAvatarProvider();

    const session = await provider.createAvatarSession({
      customerId: "customer-1",
      avatarId: "avatar-1",
    });

    expect(session.provider).toBe("simli");
    expect(session.avatarSessionId).toContain("mock-simli-");
  });
});
