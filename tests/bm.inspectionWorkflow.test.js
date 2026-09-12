import { afterEach, beforeEach, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../src/config/startupMigrations.js", () => ({
  ensureTownPlannerBookingWorkflowSchema: jest.fn(),
}));
jest.unstable_mockModule("../src/services/bm.propertyReportWorker.service.js", () => ({
  processPropertyReportCycle: jest.fn(),
}));
jest.unstable_mockModule("../src/services/bm.inspectionEmailWorker.service.js", () => ({
  processInspectionEmailCycle: jest.fn(),
}));
const { startInspectionWorkflow } = await import("../src/services/bm.inspectionWorkflow.service.js");

let workflow;
const logger = { log: jest.fn(), error: jest.fn() };
beforeEach(() => jest.useFakeTimers());
afterEach(async () => {
  await workflow?.stop();
  jest.useRealTimers();
  jest.clearAllMocks();
});

it("processes a queued report and then its email without a separate worker", async () => {
  let reportReady = false;
  let sent = false;
  const reportCycle = jest.fn(async () => {
    if (reportReady) return { status: "idle" };
    reportReady = true;
    return { status: "ready" };
  });
  const emailCycle = jest.fn(async () => {
    if (!reportReady || sent) return { status: "idle" };
    sent = true;
    return { status: "sent" };
  });
  workflow = startInspectionWorkflow({
    ensureSchema: jest.fn().mockResolvedValue(undefined),
    reportCycle, emailCycle, logger, env: {},
  });
  await jest.advanceTimersByTimeAsync(0);
  expect(reportReady).toBe(true);
  expect(sent).toBe(true);
  expect(reportCycle).toHaveBeenCalledTimes(2);
  expect(emailCycle).toHaveBeenCalledTimes(2);
});

it("continues email polling while a report is still generating without overlapping reports", async () => {
  let finishReport;
  const reportCycle = jest.fn(() => new Promise(resolve => { finishReport = resolve; }));
  const emailCycle = jest.fn().mockResolvedValue({ status: "idle" });
  workflow = startInspectionWorkflow({
    ensureSchema: jest.fn().mockResolvedValue(undefined),
    reportCycle, emailCycle, logger, env: {},
  });
  await jest.advanceTimersByTimeAsync(30_000);
  expect(reportCycle).toHaveBeenCalledTimes(1);
  expect(emailCycle).toHaveBeenCalledTimes(3);
  finishReport({ status: "idle" });
});

it("retries schema and cycle failures so temporary outages do not strand bookings", async () => {
  const ensureSchema = jest.fn()
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValue(undefined);
  const reportCycle = jest.fn()
    .mockRejectedValueOnce(new Error("connection reset"))
    .mockResolvedValue({ status: "idle" });
  const emailCycle = jest.fn().mockResolvedValue({ status: "lock_busy" });
  workflow = startInspectionWorkflow({ ensureSchema, reportCycle, emailCycle, logger, env: {} });
  await jest.advanceTimersByTimeAsync(0);
  expect(reportCycle).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(ensureSchema).toHaveBeenCalledTimes(2);
  expect(reportCycle).toHaveBeenCalledTimes(2);
  expect(emailCycle).toHaveBeenCalledTimes(3);
  await workflow.stop();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(reportCycle).toHaveBeenCalledTimes(2);
});
