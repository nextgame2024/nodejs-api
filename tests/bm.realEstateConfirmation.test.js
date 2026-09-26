import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const booking = {
  bookingId: "30000000-0000-4000-8000-000000000001",
  customerName: "Jose",
  customerEmail: "jlcmm66@gmail.com",
  confirmationEmailSentAt: "2026-09-08T00:00:00.000Z",
  startsAt: "2026-09-11T00:30:00.000Z",
  propertyAddress: "7/30 Sandgate Road",
  propertySuburb: "Clayfield",
  propertyCity: "Brisbane",
};

const getInspectionBooking = jest.fn();
const getInspectionDeliveryStatus = jest.fn();
const getPropertyWorkflowStatus = jest.fn();
const recordInspectionConfirmationProviderResult = jest.fn();
const markInspectionConfirmationFailed = jest.fn();
const queueSaleInspectionConfirmation = jest.fn();
const beginInspectionEmailCommand = jest.fn();
const retryInspectionEmailCommand = jest.fn();
const completeInspectionEmailCommand = jest.fn();
const failInspectionEmailCommand = jest.fn();
const searchKnowledge = jest.fn();
const sendInspectionConfirmationEmail = jest.fn();

jest.unstable_mockModule("../src/models/bm.realEstate.model.js", () => ({
  getInspectionBooking,
  getInspectionDeliveryStatus,
  getPropertyWorkflowStatus,
  recordInspectionConfirmationProviderResult,
  markInspectionConfirmationFailed,
  queueSaleInspectionConfirmation,
  beginInspectionEmailCommand,
  retryInspectionEmailCommand,
  completeInspectionEmailCommand,
  failInspectionEmailCommand,
  searchKnowledge,
}));
jest.unstable_mockModule("../src/services/bm.inspectionEmail.service.js", () => ({
  sendInspectionConfirmationEmail,
}));

const service = await import("../src/services/bm.realEstate.service.js");

describe("inspection confirmation resend", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getInspectionBooking.mockResolvedValue(booking);
    sendInspectionConfirmationEmail.mockResolvedValue({
      state: "accepted", provider: "ses", providerMessageId: "message-1",
    });
    recordInspectionConfirmationProviderResult.mockResolvedValue(undefined);
    queueSaleInspectionConfirmation.mockResolvedValue({
      deliveryStatus: "waiting_report",
      reportStatus: "queued",
    });
    beginInspectionEmailCommand.mockResolvedValue({ created: true, status: "executing" });
    retryInspectionEmailCommand.mockResolvedValue(true);
    completeInspectionEmailCommand.mockResolvedValue(undefined);
    failInspectionEmailCommand.mockResolvedValue(undefined);
  });

  it("requires customer confirmation before sending", async () => {
    await expect(service.sendInspectionConfirmation(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      { customerEmail: "jlcm66@gmail.com", forceResend: true },
    )).rejects.toThrow("Customer confirmation is required");
    expect(sendInspectionConfirmationEmail).not.toHaveBeenCalled();
  });

  it("RE-05 resends to the corrected address and stores it on the booking", async () => {
    const result = await service.sendInspectionConfirmation(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      {
        customerEmail: "jlcm66@gmail.com",
        confirmed: true,
        forceResend: true,
      },
    );

    expect(sendInspectionConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: "jlcm66@gmail.com" }),
    );
    expect(recordInspectionConfirmationProviderResult).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      "jlcm66@gmail.com",
      { state: "accepted", provider: "ses", providerMessageId: "message-1" },
    );
    expect(result).toEqual(expect.objectContaining({
      status: "provider_accepted",
      customerEmail: "jlcm66@gmail.com",
      resent: true,
    }));
  });

  it("does not send a BUY confirmation before its property report is ready", async () => {
    getInspectionBooking.mockResolvedValue({
      ...booking,
      listingType: "sale",
      confirmationEmailSentAt: null,
    });

    const result = await service.sendInspectionConfirmation(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      { customerEmail: "jlcm66@gmail.com", confirmed: true },
    );

    expect(sendInspectionConfirmationEmail).not.toHaveBeenCalled();
    expect(queueSaleInspectionConfirmation).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      "jlcm66@gmail.com",
      false,
    );
    expect(result).toEqual(expect.objectContaining({
      status: "pending_report",
      customerEmail: "jlcm66@gmail.com",
    }));
  });

  it("requeues a corrected BUY recipient with the ready report", async () => {
    getInspectionBooking.mockResolvedValue({ ...booking, listingType: "sale" });
    queueSaleInspectionConfirmation.mockResolvedValue({
      deliveryStatus: "email_queued",
      reportStatus: "ready",
    });

    const result = await service.sendInspectionConfirmation(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      {
        customerEmail: "jlcm66@gmail.com",
        confirmed: true,
        forceResend: true,
      },
    );

    expect(sendInspectionConfirmationEmail).not.toHaveBeenCalled();
    expect(queueSaleInspectionConfirmation).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      "jlcm66@gmail.com",
      true,
    );
    expect(result).toEqual(expect.objectContaining({
      status: "queued",
      customerEmail: "jlcm66@gmail.com",
      resent: true,
    }));
  });

  it("returns the stored receipt for a repeated resend command", async () => {
    const stored = { status: "provider_accepted", customerEmail: "jlcm66@gmail.com", resent: true };
    beginInspectionEmailCommand.mockResolvedValue({
      created: false,
      status: "completed",
      response: stored,
    });

    await expect(service.sendInspectionConfirmation(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      {
        customerEmail: "jlcm66@gmail.com",
        confirmed: true,
        forceResend: true,
        idempotencyKey: "sophia:command-1",
      },
    )).resolves.toEqual(stored);

    expect(sendInspectionConfirmationEmail).not.toHaveBeenCalled();
    expect(completeInspectionEmailCommand).not.toHaveBeenCalled();
  });

  it("does not repeat a resend whose provider outcome is unknown", async () => {
    beginInspectionEmailCommand.mockResolvedValue({ created: false, status: "unknown" });

    await expect(service.sendInspectionConfirmation(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      {
        customerEmail: "jlcm66@gmail.com",
        confirmed: true,
        forceResend: true,
        idempotencyKey: "sophia:command-2",
      },
    )).rejects.toThrow("still being reconciled");

    expect(sendInspectionConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe("normalized report and delivery status", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reports provider acceptance as processing and omits internal errors", async () => {
    getInspectionDeliveryStatus.mockResolvedValue({
      deliveryId: "40000000-0000-4000-8000-000000000001",
      bookingId: booking.bookingId,
      reportJobId: "50000000-0000-4000-8000-000000000001",
      status: "provider_accepted",
      reportStatus: "ready",
      attemptCount: 1,
      providerKey: "ses",
      providerMessageId: "message-1",
      providerAcceptedAt: "2026-09-24T00:00:00.000Z",
      verifiedDeliveredAt: null,
      lastError: "internal provider detail",
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
    const result = await service.getInspectionDeliveryStatus(
      "10000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000001",
    );
    expect(result).toMatchObject({
      status: "processing",
      detail: { deliveryStatus: "provider_accepted", reportStatus: "ready", verifiedDeliveredAt: null },
    });
    expect(JSON.stringify(result)).not.toContain("internal provider detail");
  });

  it("reports completed report generation independently from delivery", async () => {
    getPropertyWorkflowStatus.mockResolvedValue({
      workflowRef: "50000000-0000-4000-8000-000000000001",
      status: "ready",
      attemptCount: 1,
      completedAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
    await expect(service.getPropertyWorkflowStatus(
      "10000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000001",
    )).resolves.toMatchObject({ status: "succeeded", detail: { reportStatus: "ready" } });
  });
});

describe("agency knowledge search", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("RE-06 answers from tenant-scoped agency knowledge when the exact question has no match", async () => {
    const rentalGuidance = [{
      knowledgeId: "40000000-0000-4000-8000-000000000001",
      category: "renting",
      question: "What documents should I prepare?",
      answer: "Prepare identity, income and rental history documents.",
    }];
    searchKnowledge.mockResolvedValueOnce([]).mockResolvedValueOnce(rentalGuidance);

    await expect(service.searchKnowledge(
      "10000000-0000-4000-8000-000000000001",
      { q: "Show me the requirements to rent this property", category: "general" },
    )).resolves.toEqual(rentalGuidance);

    expect(searchKnowledge).toHaveBeenNthCalledWith(
      1,
      "10000000-0000-4000-8000-000000000001",
      "Show me the requirements to rent this property",
      "renting",
      3,
    );
    expect(searchKnowledge).toHaveBeenNthCalledWith(
      2,
      "10000000-0000-4000-8000-000000000001",
      "",
      "renting",
      3,
    );
  });
});
