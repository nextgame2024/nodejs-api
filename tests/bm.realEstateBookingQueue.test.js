import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const query = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));
const enqueueSaleReportDelivery = jest.fn();

jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { connect },
}));
jest.unstable_mockModule("../src/models/bm.propertyReportJobs.model.js", () => ({
  enqueueSaleReportDelivery,
}));

const model = await import("../src/models/bm.realEstate.model.js");

const existingBooking = {
  bookingId: "30000000-0000-4000-8000-000000000001",
  companyId: "10000000-0000-4000-8000-000000000001",
  propertyId: "20000000-0000-4000-8000-000000000001",
  propertyUpdatedAt: "2026-09-12T00:00:00.000Z",
};

describe("inspection booking report enqueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enqueueSaleReportDelivery.mockResolvedValue({
      reportStatus: "queued",
      deliveryStatus: "waiting_report",
    });
  });

  it("does not enqueue a Town Planner report for a rental booking", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ ...existingBooking, listingType: "rent" }] })
      .mockResolvedValueOnce({});

    const result = await model.createInspectionBooking("company", {
      idempotencyKey: "rental-booking",
    }, { reportVersion: "report-v1" });

    expect(result.listingType).toBe("rent");
    expect(enqueueSaleReportDelivery).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });

  it("idempotently attaches a report delivery to an existing sale booking", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ ...existingBooking, listingType: "sale" }] })
      .mockResolvedValueOnce({});

    const result = await model.createInspectionBooking("company", {
      idempotencyKey: "sale-booking",
    }, { reportVersion: "report-v1" });

    expect(enqueueSaleReportDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      expect.objectContaining({
        bookingId: existingBooking.bookingId,
        reportVersion: "report-v1",
      }),
    );
    expect(result.reportDelivery).toEqual({
      reportStatus: "queued",
      deliveryStatus: "waiting_report",
    });
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });
});
