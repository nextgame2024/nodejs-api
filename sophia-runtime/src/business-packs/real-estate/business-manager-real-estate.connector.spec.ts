import { describe, expect, it, jest } from "@jest/globals";
import { MemoryActionReviewStore } from "../../tools/action-review.store.js";
import type { BusinessManagerClient } from "./business-manager.client.js";
import { BusinessManagerRealEstateConnector, businessManagerRealEstatePorts } from "./business-manager-real-estate.connector.js";

const bindingId = "11111111-1111-4111-8111-111111111111";
const connectorBindingId = "66666666-6666-4666-8666-666666666666";
const tenantId = "22222222-2222-4222-8222-222222222222";
const propertyId = "33333333-3333-4333-8333-333333333333";
const slotId = "44444444-4444-4444-8444-444444444444";
const bookingId = "55555555-5555-4555-8555-555555555555";
const now = "2026-10-01T00:30:00.000Z";
const context = {
  tenantId,
  sessionId: "session-1",
  capabilityBindingId: bindingId,
  connectorBindingId,
  actorRef: "customer",
  correlationId: "correlation-1",
  deadline: "2026-10-01T01:00:00.000Z",
};

describe("BusinessManagerRealEstateConnector", () => {
  it("maps authoritative catalog fields, pagination and missing optional fields without invention", async () => {
    const searchProperties = jest.fn<BusinessManagerClient["searchProperties"]>().mockResolvedValue({ properties: [
      property("First"), property("Second", { description: null, bedrooms: null, media: [] }), property("Next page"),
    ] });
    const connector = createConnector({ searchProperties });
    const result = await businessManagerRealEstatePorts(connector).catalog.search({
      query: "Brisbane", page: { limit: 2 }, extension: { listingType: "rent", suburbs: ["Nundah"] },
    }, context);

    expect(searchProperties).toHaveBeenCalledWith(expect.objectContaining({ limit: 3, offset: 0, suburbs: ["Nundah"] }));
    expect(result.page).toEqual({ hasMore: true, nextCursor: "offset:2" });
    expect(result.items[1]?.extension).not.toHaveProperty("bedrooms");
    expect(result.items[1]).not.toHaveProperty("summary");
  });

  it("rejects a resource from another connector binding before calling Business Manager", async () => {
    const getProperty = jest.fn<BusinessManagerClient["getProperty"]>();
    const connector = createConnector({ getProperty });
    await expect(businessManagerRealEstatePorts(connector).catalog.get({
      resource: { connectorBindingId: "99999999-9999-4999-8999-999999999999", opaqueId: propertyId },
    }, context)).rejects.toThrow("does not match");
    expect(getProperty).not.toHaveBeenCalled();
  });

  it("revalidates capacity and binds the committed booking to the durable review command", async () => {
    const getInspectionSlot = jest.fn<BusinessManagerClient["getInspectionSlot"]>().mockResolvedValue({ slot: {
      slotId, propertyId, startsAt: now, endsAt: "2026-10-01T01:00:00.000Z", capacity: 2, placesAvailable: 1,
      startsAtLabel: "Thu, 1 Oct, 10:30 am", status: "open",
    } });
    const bookInspection = jest.fn<BusinessManagerClient["bookInspection"]>().mockResolvedValue({ booking: {
      bookingId, propertyId, slotId, listingType: "rent", status: "confirmed", title: undefined,
    } });
    const reviews = new MemoryActionReviewStore();
    const connector = createConnector({ getInspectionSlot, bookInspection }, reviews);
    const ports = businessManagerRealEstatePorts(connector);
    const extension = { propertyAddress: "11 Example Street", startsAtLabel: "Thu, 1 Oct, 10:30 am",
      confirmedStartsAt: now, customerName: "Jordan Lee", customerEmail: "JORDAN@example.com" };
    const prepared = await ports.booking.prepare({ resource: { connectorBindingId, opaqueId: propertyId }, optionRef: slotId, extension }, context);
    await reviews.confirm({ customerId: tenantId, sessionId: context.sessionId }, prepared.reviewId);
    const receipt = await ports.booking.commit({ reviewId: prepared.reviewId, commandId: prepared.commandId,
      extension: { ...extension, propertyId, slotId } }, context);

    expect(bookInspection).toHaveBeenCalledWith(expect.objectContaining({
      propertyId, slotId, customerEmail: "jordan@example.com", idempotencyKey: `sophia:${prepared.commandId}`,
    }));
    expect(receipt).toMatchObject({ commandId: prepared.commandId, operationRef: bookingId, status: "succeeded" });
  });

  it("uses authoritative reconciliation without retrying a mutation", async () => {
    const reconcileBooking = jest.fn<BusinessManagerClient["reconcileBooking"]>().mockResolvedValue({ operation: {
      operationRef: bookingId, status: "succeeded", updatedAt: now,
    } });
    const connector = createConnector({ reconcileBooking });
    await expect(businessManagerRealEstatePorts(connector).booking.reconcile({ commandId: "command-1" }, context))
      .resolves.toEqual({ operationRef: bookingId, status: "succeeded", updatedAt: now });
    expect(reconcileBooking).toHaveBeenCalledWith("sophia:command-1");
  });

  it("preserves honest report and provider milestones in shared status output", async () => {
    const getDeliveryStatus = jest.fn<BusinessManagerClient["getDeliveryStatus"]>().mockResolvedValue({ operation: {
      operationRef: bookingId,
      status: "processing",
      updatedAt: now,
      detail: { deliveryStatus: "provider_accepted", reportStatus: "ready", verifiedDeliveredAt: null },
    } });
    const connector = createConnector({ getDeliveryStatus });
    await expect(businessManagerRealEstatePorts(connector).delivery.getStatus({ operationRef: bookingId }, context))
      .resolves.toEqual({
        operationRef: bookingId,
        status: "processing",
        updatedAt: now,
        extension: { deliveryStatus: "provider_accepted", reportStatus: "ready", verifiedDeliveredAt: null },
      });
  });
});

function createConnector(methods: Partial<BusinessManagerClient>, reviews = new MemoryActionReviewStore()) {
  return new BusinessManagerRealEstateConnector(
    methods as BusinessManagerClient,
    reviews as never,
  );
}

function property(title: string, changes: Record<string, unknown> = {}) {
  return {
    propertyId, listingType: "rent" as const, title, suburb: "Nundah", priceDisplay: "$620 per week",
    bedrooms: 2, bathrooms: 1, description: "Authoritative description", features: [], media: [], ...changes,
  };
}
