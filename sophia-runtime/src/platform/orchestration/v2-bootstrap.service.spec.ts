import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { V2BootstrapService } from "./v2-bootstrap.service.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const installationKey = "installation-key-that-is-at-least-32-characters";

describe("v2 bootstrap boundary", () => {
  beforeEach(() => {
    process.env.SOPHIA_RUNTIME_DATABASE_URL = "postgres://example";
    process.env.SOPHIA_DEFAULT_CUSTOMER_ID = tenantId;
    process.env.SOPHIA_V2_CANARY_TENANT_IDS = tenantId;
    process.env.SOPHIA_V2_INSTALLATION_KEY = installationKey;
  });

  it("issues an opaque bootstrap token only after installation, device and profile checks", async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ store_id: "store-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const database = { tenantTransaction: jest.fn((_tenant: string, work: Function) => work({ query })) };
    const service = new V2BootstrapService(database as never);

    const result = await service.issue({ experienceId: "essential", deviceId }, installationKey);

    expect(result.bootstrapToken.length).toBeGreaterThanOrEqual(32);
    expect(database.tenantTransaction).toHaveBeenCalledWith(tenantId, expect.any(Function));
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects a replayed grant", async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{
      bootstrap_id: "33333333-3333-4333-8333-333333333333",
      device_id: deviceId,
      experience_key: "essential",
      status: "redeemed",
      expires_at: new Date(Date.now() + 60_000),
      store_id: null,
    }], rowCount: 1 });
    const database = { tenantTransaction: jest.fn((_tenant: string, work: Function) => work({ query })) };
    const service = new V2BootstrapService(database as never);

    await expect(service.redeem("already-used-token", { experienceId: "essential", deviceId }))
      .rejects.toThrow("invalid, expired, or already used");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails closed outside the tenant canary", async () => {
    process.env.SOPHIA_V2_CANARY_TENANT_IDS = "";
    const database = { tenantTransaction: jest.fn() };
    const service = new V2BootstrapService(database as never);
    await expect(service.issue({ experienceId: "essential", deviceId }, installationKey))
      .rejects.toThrow("not enabled");
    expect(database.tenantTransaction).not.toHaveBeenCalled();
  });
});
