import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const query = jest.fn();
const release = jest.fn();
const connect = jest.fn().mockResolvedValue({ query, release });
jest.unstable_mockModule("../src/config/db.js", () => ({
  default: { connect, query: jest.fn() },
}));
jest.unstable_mockModule("../src/models/bm.demoInspectionSlots.model.js", () => ({
  isDemoPropertyId: jest.fn().mockReturnValue(false), refreshDemoInspectionSlots: jest.fn(),
}));
jest.unstable_mockModule("../src/models/bm.propertyReportJobs.model.js", () => ({
  enqueueSaleReportDelivery: jest.fn(),
}));

const model = await import("../src/models/bm.realEstate.model.js");

describe("Business Manager privacy persistence adapter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ booking_id: "11111111-1111-4111-8111-111111111111" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
  });

  it("de-identifies bookings, email commands and provider delivery identifiers atomically", async () => {
    const result = await model.redactInspectionPrivacyDataByCommands("company-1", ["command-1"]);
    expect(result).toEqual({ bookingsRedacted: 1, emailCommandsRedacted: 2, deliveriesRedacted: 1 });
    expect(query.mock.calls[1][0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[3][0]).toContain("customer_email = 'deleted+'");
    expect(query.mock.calls[4][0]).toContain("response = '{\"redacted\":true}'::jsonb");
    expect(query.mock.calls[5][0]).toContain("provider_message_id = NULL");
    expect(query.mock.calls[6][0]).toBe("COMMIT");
    expect(release).toHaveBeenCalled();
  });
});
