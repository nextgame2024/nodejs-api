import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { sendInspectionConfirmationEmail } from "../src/services/bm.inspectionEmail.service.js";

const originalProvider = process.env.EMAIL_PROVIDER;

describe("inspection confirmation email", () => {
  afterEach(() => {
    if (originalProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = originalProvider;
    jest.restoreAllMocks();
  });

  it("uses the confirmed recipient and authoritative inspection label", async () => {
    process.env.EMAIL_PROVIDER = "log";
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);

    await sendInspectionConfirmationEmail({
      bookingId: "30000000-0000-4000-8000-000000000001",
      customerName: "Jordan Lee",
      customerEmail: "jordan@example.com",
      propertyAddress: "18 Jacaranda Street",
      propertySuburb: "Bulimba",
      propertyCity: "Brisbane",
      propertyState: "QLD",
      propertyPostcode: "4171",
      startsAtLabel: "Wed, 9 Sept, 10:30 am",
    });

    expect(log).toHaveBeenCalledWith(
      "[inspection-email][LOG] To:",
      "jordan@example.com",
    );
    expect(log).toHaveBeenCalledWith(
      "[inspection-email][LOG] Time:",
      "Wed, 9 Sept, 10:30 am",
    );
  });
});
