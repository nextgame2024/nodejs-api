import { jest, describe, test, expect, afterEach } from "@jest/globals";
jest.unstable_mockModule("../src/config/db.js", () => ({ default: {} }));
jest.unstable_mockModule("../src/services/leads/form-email.service.js", () => ({
  processFormEmail: jest.fn(),
}));
const { startFormEmailWorkflow } = await import(
  "../src/services/leads/form-email-workflow.service.js"
);
afterEach(() => jest.useRealTimers());
describe("Form email workflow", () => {
  test("processes active registry tenants and stops polling when stopped", async () => {
    jest.useFakeTimers();
    const db = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ ready: true }] })
        .mockResolvedValueOnce({
          rows: [{ customer_id: "tenant-a" }, { customer_id: "tenant-b" }],
        }),
      release: jest.fn(),
    };
    const database = { connect: jest.fn().mockResolvedValue(db) },
      deliver = jest.fn().mockResolvedValue("sent");
    const stop = startFormEmailWorkflow({ database, deliver });
    await jest.advanceTimersByTimeAsync(0);
    expect(deliver.mock.calls.map((c) => c[1])).toEqual([
      "tenant-a",
      "tenant-b",
    ]);
    expect(db.query.mock.calls[1][0]).toContain("status='active'");
    expect(db.release).toHaveBeenCalledTimes(1);
    stop();
    await jest.advanceTimersByTimeAsync(30000);
    expect(database.connect).toHaveBeenCalledTimes(1);
  });
  test("waits for setup and retries transient connection errors", async () => {
    jest.useFakeTimers();
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ ready: false }] }),
      release: jest.fn(),
    };
    const database = {
        connect: jest
          .fn()
          .mockRejectedValueOnce(new Error("temporary"))
          .mockResolvedValue(db),
      },
      deliver = jest.fn(),
      logger = { error: jest.fn() };
    const stop = startFormEmailWorkflow({ database, deliver, logger });
    await jest.advanceTimersByTimeAsync(15000);
    stop();
    expect(database.connect).toHaveBeenCalledTimes(2);
    expect(deliver).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalled();
  });
});
