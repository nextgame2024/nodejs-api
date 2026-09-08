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
const sendInspectionConfirmationEmail = jest.fn();

jest.unstable_mockModule("../src/models/bm.realEstate.model.js", () => ({
  getInspectionBooking,
  markInspectionConfirmationSent,
  markInspectionConfirmationFailed,
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
});
