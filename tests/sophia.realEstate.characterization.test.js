import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  capacityOneSlot,
  companyId,
  multiCapacitySlot,
  propertyWithMissingOptionalFields,
  rentalBooking,
  rentalProperty,
  saleBookingWaitingForReport,
  saleDeliveryStates,
  saleProperty,
} from "./fixtures/sophiaRealEstate.fixture.js";

const searchProperties = jest.fn();
const getProperty = jest.fn();
const listInspectionSlots = jest.fn();
const createInspectionBooking = jest.fn();
const getInspectionBooking = jest.fn();
const markInspectionConfirmationSent = jest.fn();
const markInspectionConfirmationFailed = jest.fn();
const queueSaleInspectionConfirmation = jest.fn();
const searchKnowledge = jest.fn();
const findInspectionBookingByCommand = jest.fn();
const getInspectionDeliveryStatus = jest.fn();
const getInspectionEmailCommand = jest.fn();
const getPropertyWorkflowStatus = jest.fn();
const sendInspectionConfirmationEmail = jest.fn();

jest.unstable_mockModule("../src/models/bm.realEstate.model.js", () => ({
  searchProperties,
  getProperty,
  listInspectionSlots,
  createInspectionBooking,
  getInspectionBooking,
  markInspectionConfirmationSent,
  markInspectionConfirmationFailed,
  queueSaleInspectionConfirmation,
  searchKnowledge,
  findInspectionBookingByCommand,
  getInspectionDeliveryStatus,
  getInspectionEmailCommand,
  getPropertyWorkflowStatus,
}));

jest.unstable_mockModule("../src/services/bm.inspectionEmail.service.js", () => ({
  sendInspectionConfirmationEmail,
}));

const service = await import("../src/services/bm.realEstate.service.js");

describe("P0 real-estate characterization fixtures", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("RE-01 preserves authoritative sale and rental values, including photographs", async () => {
    searchProperties
      .mockResolvedValueOnce([rentalProperty])
      .mockResolvedValueOnce([saleProperty]);

    const rentals = await service.searchProperties(companyId, {
      listingType: "rent",
      location: "Brisbane",
    });
    const sales = await service.searchProperties(companyId, {
      listingType: "sale",
      location: "Brisbane",
    });

    expect(rentals).toEqual([rentalProperty]);
    expect(sales).toEqual([saleProperty]);
    expect(rentals[0].media[0].url).toBe(
      "https://fixtures.invalid/rental-1.jpg",
    );
    expect(sales[0].priceDisplay).toBe("Offers over $1,050,000");
    expect(searchProperties).toHaveBeenNthCalledWith(
      1,
      companyId,
      expect.objectContaining({ listingType: "rent", location: "Brisbane", limit: 3 }),
    );
    expect(searchProperties).toHaveBeenNthCalledWith(
      2,
      companyId,
      expect.objectContaining({ listingType: "sale", location: "Brisbane", limit: 3 }),
    );
  });

  it("RE-01 leaves missing optional property data unavailable instead of inventing it", async () => {
    getProperty.mockResolvedValue(propertyWithMissingOptionalFields);

    const property = await service.getProperty(
      companyId,
      propertyWithMissingOptionalFields.propertyId,
    );

    expect(property.description).toBeNull();
    expect(property.agentPhone).toBeNull();
    expect(property.media).toEqual([]);
  });

  it("RE-02 preserves capacity-one and multi-capacity availability", async () => {
    listInspectionSlots.mockResolvedValue([
      capacityOneSlot,
      multiCapacitySlot,
    ]);

    const slots = await service.listInspectionSlots(
      companyId,
      rentalProperty.propertyId,
      {
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-04T00:00:00.000Z",
      },
    );

    expect(slots).toEqual([
      expect.objectContaining({ capacity: 1, placesAvailable: 1 }),
      expect.objectContaining({ capacity: 4, placesAvailable: 2 }),
    ]);
    expect(slots.every((slot) => slot.timeZone === "Australia/Brisbane")).toBe(true);
    expect(slots.every((slot) => typeof slot.startsAtLabel === "string")).toBe(true);
  });

  it("RE-03 keeps rental booking state independent from sale report state", async () => {
    createInspectionBooking.mockResolvedValue(rentalBooking);

    const result = await service.createInspectionBooking(companyId, {
      propertyId: rentalBooking.propertyId,
      slotId: rentalBooking.slotId,
      confirmedStartsAt: rentalBooking.startsAt,
      customerName: rentalBooking.customerName,
      customerEmail: rentalBooking.customerEmail,
      idempotencyKey: "p0-rental-command",
    });

    expect(result.listingType).toBe("rent");
    expect(result.reportDelivery).toBeUndefined();
  });

  it("RE-04 returns a committed sale booking while its report remains queued", async () => {
    createInspectionBooking.mockResolvedValue(saleBookingWaitingForReport);

    const result = await service.createInspectionBooking(companyId, {
      propertyId: saleBookingWaitingForReport.propertyId,
      slotId: saleBookingWaitingForReport.slotId,
      confirmedStartsAt: saleBookingWaitingForReport.startsAt,
      customerName: saleBookingWaitingForReport.customerName,
      customerEmail: saleBookingWaitingForReport.customerEmail,
      idempotencyKey: "p0-sale-command",
    });

    expect(result.status).toBe("confirmed");
    expect(result.reportDelivery).toEqual(
      expect.objectContaining({
        reportStatus: "queued",
        deliveryStatus: "waiting_report",
      }),
    );
    expect(saleDeliveryStates).toContain(result.reportDelivery.deliveryStatus);
    expect(sendInspectionConfirmationEmail).not.toHaveBeenCalled();
  });

  it("RE-03 exposes tenant-scoped authoritative booking status and reconciliation", async () => {
    getInspectionBooking.mockResolvedValue(rentalBooking);
    findInspectionBookingByCommand.mockResolvedValue(rentalBooking);

    await expect(service.getInspectionBookingStatus(companyId, rentalBooking.bookingId)).resolves.toMatchObject({
      operationRef: rentalBooking.bookingId,
      status: "succeeded",
    });
    await expect(service.reconcileInspectionBooking(companyId, "sophia:command-1")).resolves.toMatchObject({
      operationRef: rentalBooking.bookingId,
      status: "succeeded",
    });
    expect(getInspectionBooking).toHaveBeenCalledWith(companyId, rentalBooking.bookingId);
    expect(findInspectionBookingByCommand).toHaveBeenCalledWith(companyId, "sophia:command-1");
  });

  it("keeps a missing command outcome unknown instead of retrying or claiming failure", async () => {
    findInspectionBookingByCommand.mockResolvedValue(null);
    await expect(service.reconcileInspectionBooking(companyId, "sophia:unknown-command")).resolves.toMatchObject({
      operationRef: "sophia:unknown-command",
      status: "outcome_unknown",
    });
  });
});
