import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../src/models/bm.propertyReportWorker.model.js", () => ({}));
jest.unstable_mockModule("../src/models/townplanner_v2.model.js", () => ({
  findReadyReportByHashV2: jest.fn(),
}));
jest.unstable_mockModule("../src/services/townplanner_report_v2.service.js", () => ({
  computeInputsHashV2: jest.fn().mockReturnValue("inputs-hash"),
  generateTownPlannerReportV2: jest.fn(),
}));

const { processPropertyReportCycle, propertyReportWorkerConfig } = await import(
  "../src/services/bm.propertyReportWorker.service.js"
);

const config = {
  lockId: 123,
  leaseSeconds: 900,
  maxInitialAttempts: 3,
  retryDelaySeconds: 120,
  dailyRetryDelaySeconds: 86400,
};

function createModel(job) {
  return {
    acquireWorkerLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    recoverExpiredJobs: jest.fn().mockResolvedValue(0),
    claimNextJob: jest.fn().mockResolvedValue(job),
    renewLease: jest.fn().mockResolvedValue(true),
    markJobReady: jest.fn().mockResolvedValue(undefined),
    markJobFailed: jest.fn(),
  };
}

const job = {
  reportJobId: "30000000-0000-4000-8000-000000000001",
  attemptCount: 1,
  reportInputs: {
    addressLabel: "12 Smith Street, West End, Brisbane, QLD, 4101",
    lat: -27.4815,
    lng: 153.0124,
  },
};

describe("property report worker", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not claim work when another process owns the global lock", async () => {
    const model = createModel(job);
    model.acquireWorkerLock.mockResolvedValue(null);

    const result = await processPropertyReportCycle({ model, config });

    expect(result.status).toBe("lock_busy");
    expect(model.claimNextJob).not.toHaveBeenCalled();
  });

  it("uses safe defaults when numeric environment values are invalid", () => {
    expect(propertyReportWorkerConfig({
      PROPERTY_REPORT_LEASE_SECONDS: "not-a-number",
      PROPERTY_REPORT_MAX_INITIAL_ATTEMPTS: "0",
    })).toEqual(expect.objectContaining({
      leaseSeconds: 900,
      maxInitialAttempts: 3,
    }));
  });

  it("generates one claimed report and marks it ready", async () => {
    const model = createModel(job);
    const generateReport = jest.fn().mockResolvedValue({
      pdfKey: "reports/property.pdf",
      pdfUrl: "https://example.test/property.pdf",
    });

    const result = await processPropertyReportCycle({
      model,
      generateReport,
      workerId: "worker-1",
      config,
    });

    expect(generateReport).toHaveBeenCalledWith(expect.objectContaining({
      token: job.reportJobId,
      lat: -27.4815,
      lng: 153.0124,
    }));
    expect(model.markJobReady).toHaveBeenCalledWith(expect.objectContaining({
      reportJobId: job.reportJobId,
      workerId: "worker-1",
    }));
    expect(result.status).toBe("ready");
    expect((await model.acquireWorkerLock.mock.results[0].value).release).toHaveBeenCalled();
  });

  it("reuses a cached report without running PDF generation", async () => {
    const model = createModel(job);
    const generateReport = jest.fn();
    const cached = {
      pdfKey: "reports/cached.pdf",
      pdfUrl: "https://example.test/cached.pdf",
    };

    const result = await processPropertyReportCycle({
      model,
      generateReport,
      findCachedReport: jest.fn().mockResolvedValue(cached),
      workerId: "worker-1",
      config,
    });

    expect(generateReport).not.toHaveBeenCalled();
    expect(model.markJobReady).toHaveBeenCalledWith(expect.objectContaining({
      result: cached,
    }));
    expect(result.status).toBe("ready");
  });

  it("schedules another initial attempt after a generation failure", async () => {
    const model = createModel(job);
    model.markJobFailed.mockResolvedValue({
      attemptCount: 1,
      initialAttemptsExhaustedAt: null,
    });

    const result = await processPropertyReportCycle({
      model,
      generateReport: jest.fn().mockRejectedValue(new Error("map request failed")),
      workerId: "worker-1",
      config,
    });

    expect(model.markJobFailed).toHaveBeenCalledWith(expect.objectContaining({
      maxInitialAttempts: 3,
      retryDelaySeconds: 120,
      dailyRetryDelaySeconds: 86400,
    }));
    expect(result).toEqual(expect.objectContaining({
      status: "retry",
      attemptCount: 1,
      error: "map request failed",
    }));
  });

  it("moves exhausted jobs to daily recovery", async () => {
    const model = createModel({ ...job, attemptCount: 3 });
    model.markJobFailed.mockResolvedValue({
      attemptCount: 3,
      initialAttemptsExhaustedAt: new Date("2026-09-12T00:00:00.000Z"),
    });

    const result = await processPropertyReportCycle({
      model,
      generateReport: jest.fn().mockRejectedValue(new Error("PDF failed")),
      workerId: "worker-1",
      config,
    });

    expect(result.status).toBe("daily_retry");
  });
});
