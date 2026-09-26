import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const getInspectionPrivacyDataByCommands = jest.fn();
const redactInspectionPrivacyDataByCommands = jest.fn();

jest.unstable_mockModule("../src/models/bm.realEstate.model.js", () => ({
  getInspectionPrivacyDataByCommands,
  redactInspectionPrivacyDataByCommands,
}));
jest.unstable_mockModule("../src/services/bm.inspectionEmail.service.js", () => ({
  sendInspectionConfirmationEmail: jest.fn(),
}));

const service = await import("../src/services/bm.realEstate.service.js");

describe("Business Manager privacy owner adapter", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns bounded owner data with integrity evidence", async () => {
    getInspectionPrivacyDataByCommands.mockResolvedValue([{ bookingId: "booking-1", customerEmail: "person@example.com" }]);
    const result = await service.getInspectionPrivacyData("company-1", { commandIds: ["command-1"] });
    expect(getInspectionPrivacyDataByCommands).toHaveBeenCalledWith("company-1", ["command-1"]);
    expect(result.document.bookings).toHaveLength(1);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns owner redaction counts and a digest without echoing subject data", async () => {
    redactInspectionPrivacyDataByCommands.mockResolvedValue({
      bookingsRedacted: 1, emailCommandsRedacted: 2, deliveriesRedacted: 1,
    });
    const result = await service.redactInspectionPrivacyData("company-1", { commandIds: ["command-1"] });
    expect(result).toMatchObject({ status: "completed", counts: { bookingsRedacted: 1 } });
    expect(JSON.stringify(result)).not.toContain("person@example.com");
  });

  it("rejects unbounded or malformed command selectors", async () => {
    await expect(service.redactInspectionPrivacyData("company-1", { commandIds: "command-1" }))
      .rejects.toThrow("commandIds must be an array");
    await expect(service.redactInspectionPrivacyData("company-1", { commandIds: Array(101).fill("command") }))
      .rejects.toThrow("at most 100");
  });
});
