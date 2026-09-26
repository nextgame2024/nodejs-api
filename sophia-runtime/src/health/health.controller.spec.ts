import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { HealthController } from "./health.controller.js";

const originalRevision = process.env.RENDER_GIT_COMMIT;

describe("HealthController", () => {
  afterEach(() => {
    if (originalRevision === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = originalRevision;
  });

  it("reports a bounded non-secret deployment revision after database readiness", async () => {
    process.env.RENDER_GIT_COMMIT = "51d7b71abcdef0123456789";
    const database = { ping: jest.fn(async () => undefined) };
    const controller = new HealthController(database as never);
    await expect(controller.healthz()).resolves.toEqual({ ok: true, revision: "51d7b71abcde" });
    expect(database.ping).toHaveBeenCalledTimes(1);
  });
});
