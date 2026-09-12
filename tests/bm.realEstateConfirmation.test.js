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
const markInspectionConfirmationSent = jest.fn();
const markInspectionConfirmationFailed = jest.fn();
const queueSaleInspectionConfirmation = jest.fn();
const searchKnowledge = jest.fn();
const sendInspectionConfirmationEmail = jest.fn();

jest.unstable_mockModule("../src/models/bm.realEstate.model.js", () => ({
  getInspectionBooking,
  markInspectionConfirmationSent,
  markInspectionConfirmationFailed,
  queueSaleInspectionConfirmation,
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
    sendInspectionConfirmationEmail.mockResolvedValue(undefined);
    markInspectionConfirmationSent.mockResolvedValue(undefined);
    queueSaleInspectionConfirmation.mockResolvedValue({
      deliveryStatus: "waiting_report",
      reportStatus: "queued",
    });
  });

  it("requires customer confirmation before sending", async () => {
    await expect(service.sendInspectionConfirmation(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      { customerEmail: "jlcm66@gmail.com", forceResend: true },
    )).rejects.toThrow("Customer confirmation is required");
    expect(sendInspectionConfirmationEmail).not.toHaveBeenCalled();
  });

  it("resends to the corrected address and stores it on the booking", async () => {
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
    expect(markInspectionConfirmationSent).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      booking.bookingId,
      "jlcm66@gmail.com",
    );
    expect(result).toEqual(expect.objectContaining({
      status: "sent",
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
});

describe("agency knowledge search", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("infers rental guidance and falls back when the exact question has no match", async () => {
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
