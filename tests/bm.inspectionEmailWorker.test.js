import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../src/models/bm.propertyReportWorker.model.js", () => ({}));
jest.unstable_mockModule("../src/services/s3.js", () => ({
  getObjectBuffer: jest.fn(),
}));
jest.unstable_mockModule("../src/services/bm.inspectionEmail.service.js", () => ({
  sendInspectionConfirmationEmail: jest.fn(),
}));

const { processInspectionEmailCycle, inspectionEmailWorkerConfig } = await import(
  "../src/services/bm.inspectionEmailWorker.service.js"
);

const config = {
  lockId: 456,
  leaseSeconds: 300,
  maxAttempts: 3,
  retryDelaySeconds: 120,
};

function createModel(delivery) {
  return {
    acquireWorkerLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    recoverExpiredDeliveries: jest.fn().mockResolvedValue(0),
    claimNextDelivery: jest.fn().mockResolvedValue(delivery),
    renewDeliveryLease: jest.fn().mockResolvedValue(true),
    markDeliveryAccepted: jest.fn().mockResolvedValue({ status: "provider_accepted" }),
    markDeliveryOutcomeUnknown: jest.fn().mockResolvedValue({ status: "outcome_unknown" }),
    markDeliveryFailed: jest.fn(),
  };
}

const delivery = {
  deliveryId: "40000000-0000-4000-8000-000000000001",
  bookingId: "50000000-0000-4000-8000-000000000001",
  attemptCount: 1,
  claimToken: "60000000-0000-4000-8000-000000000001",
  fallbackWithoutReport: false,
  customerName: "Jordan Lee",
  customerEmail: "jordan@example.com",
  startsAt: "2026-09-11T00:30:00.000Z",
  propertyAddress: "18 Jacaranda Street",
  propertySuburb: "Bulimba",
  propertyCity: "Brisbane",
  propertyState: "QLD",
  propertyPostcode: "4171",
  reportStatus: "ready",
  pdfKey: "reports/property.pdf",
};

describe("inspection confirmation email worker", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not claim email work when another process owns the global lock", async () => {
    const model = createModel(delivery);
    model.acquireWorkerLock.mockResolvedValue(null);

    const result = await processInspectionEmailCycle({ model, config });

    expect(result.status).toBe("lock_busy");
    expect(model.claimNextDelivery).not.toHaveBeenCalled();
  });

  it("uses safe defaults when numeric environment values are invalid", () => {
    expect(inspectionEmailWorkerConfig({
      INSPECTION_EMAIL_LEASE_SECONDS: "nope",
      INSPECTION_EMAIL_MAX_ATTEMPTS: "-1",
    })).toEqual(expect.objectContaining({
      leaseSeconds: 300,
      maxAttempts: 3,
    }));
  });

  it("loads and attaches a ready Town Planner report", async () => {
    const model = createModel(delivery);
    const loadReport = jest.fn().mockResolvedValue(Buffer.from("pdf"));
    const sendEmail = jest.fn().mockResolvedValue({ state: "accepted", provider: "ses", providerMessageId: "message-1" });

    const result = await processInspectionEmailCycle({
      model,
      loadReport,
      sendEmail,
      workerId: "worker-1",
      config,
    });

    expect(loadReport).toHaveBeenCalledWith("reports/property.pdf");
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ startsAtLabel: "Fri, 11 Sept, 10:30 am" }),
      expect.objectContaining({
        reportAttachment: expect.objectContaining({
          filename: "town-planner-report-18-jacaranda-street.pdf",
        }),
        reportPending: false,
      }),
    );
    expect(model.markDeliveryAccepted).toHaveBeenCalledWith(expect.objectContaining({
      claimToken: delivery.claimToken,
      providerResult: { state: "accepted", provider: "ses", providerMessageId: "message-1" },
    }));
    expect(result.status).toBe("provider_accepted");
  });

  it("sends the booking without an attachment after PDF attempts are exhausted", async () => {
    const fallback = { ...delivery, fallbackWithoutReport: true, pdfKey: null };
    const model = createModel(fallback);
    const loadReport = jest.fn();
    model.markDeliveryAccepted.mockResolvedValue({ status: "fallback_previewed" });
    const sendEmail = jest.fn().mockResolvedValue({ state: "preview", provider: "log" });

    const result = await processInspectionEmailCycle({
      model,
      loadReport,
      sendEmail,
      workerId: "worker-1",
      config,
    });

    expect(loadReport).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledWith(expect.any(Object), {
      reportAttachment: null,
      reportPending: true,
    });
    expect(result.status).toBe("fallback_previewed");
  });

  it("records any provider-submission failure as outcome unknown without automatic retry", async () => {
    const model = createModel(delivery);
    const result = await processInspectionEmailCycle({
      model,
      loadReport: jest.fn().mockResolvedValue(Buffer.from("pdf")),
      sendEmail: jest.fn().mockRejectedValue(new Error("provider connection closed after submission")),
      workerId: "worker-1",
      config,
    });
    expect(result.status).toBe("outcome_unknown");
    expect(model.markDeliveryOutcomeUnknown).toHaveBeenCalledWith(expect.objectContaining({
      claimToken: delivery.claimToken,
    }));
    expect(model.markDeliveryFailed).not.toHaveBeenCalled();
  });

  it("returns failed delivery to the retry policy", async () => {
    const model = createModel(delivery);
    model.markDeliveryFailed.mockResolvedValue({
      attemptCount: 1,
      status: "email_retry",
    });

    const result = await processInspectionEmailCycle({
      model,
      loadReport: jest.fn().mockRejectedValue(new Error("S3 unavailable")),
      sendEmail: jest.fn(),
      workerId: "worker-1",
      config,
    });

    expect(model.markDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: "S3 unavailable",
      retryDelaySeconds: 120,
    }));
    expect(result.status).toBe("email_retry");
  });
});
