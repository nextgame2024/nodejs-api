import { describe, expect, it, jest } from "@jest/globals";
import { BusinessManagerClient } from "./business-manager.client.js";
import { createRealEstateTools } from "./real-estate.tools.js";

describe("real-estate runtime tools", () => {
  it("limits property results and passes filters to Business Manager", async () => {
    const searchProperties = jest.fn<BusinessManagerClient["searchProperties"]>()
      .mockResolvedValue({ properties: [] });
    const client = { searchProperties } as unknown as BusinessManagerClient;
    const tool = createRealEstateTools(client).find(({ definition }) =>
      definition.name === "searchProperties");

    await tool?.execute(
      tool.inputSchema.parse({ listingType: "rent", city: "Brisbane", suburb: "Bulimba", minBedrooms: 3 }),
      { customerId: "customer-1" },
    );

    expect(searchProperties).toHaveBeenCalledWith({
      listingType: "rent",
      city: "Brisbane",
      suburb: "Bulimba",
      minBedrooms: 3,
      limit: 3,
    });
  });

  it("accepts an unclassified city or suburb location", async () => {
    const searchProperties = jest.fn<BusinessManagerClient["searchProperties"]>()
      .mockResolvedValue({ properties: [] });
    const client = { searchProperties } as unknown as BusinessManagerClient;
    const tool = createRealEstateTools(client).find(({ definition }) =>
      definition.name === "searchProperties");

    await tool?.execute(
      tool.inputSchema.parse({ listingType: "rent", location: "Brisbane" }),
      { customerId: "customer-1" },
    );

    expect(searchProperties).toHaveBeenCalledWith({
      listingType: "rent",
      location: "Brisbane",
      limit: 3,
    });
  });

  it("accepts null optional filters emitted by realtime providers", async () => {
    const searchProperties = jest.fn<BusinessManagerClient["searchProperties"]>()
      .mockResolvedValue({ properties: [] });
    const client = { searchProperties } as unknown as BusinessManagerClient;
    const tool = createRealEstateTools(client).find(({ definition }) =>
      definition.name === "searchProperties");

    await tool?.execute(
      tool.inputSchema.parse({
        listingType: "rent",
        location: "Kangaroo Point, Brisbane",
        propertyType: null,
      }),
      { customerId: "customer-1" },
    );

    expect(searchProperties).toHaveBeenCalledWith({
      listingType: "rent",
      location: "Kangaroo Point, Brisbane",
      propertyType: undefined,
      limit: 3,
    });
  });

  it("requires explicit confirmation before booking", () => {
    const client = {} as BusinessManagerClient;
    const tool = createRealEstateTools(client).find(({ definition }) =>
      definition.name === "bookInspection");

    expect(() => tool?.inputSchema.parse({
      propertyId: "10000000-0000-4000-8000-000000000001",
      slotId: "20000000-0000-4000-8000-000000000001",
      customerName: "Jordan Lee",
      customerEmail: "jordan@example.com",
      confirmed: false,
    })).toThrow();
  });

  it("passes the selected slot timestamp through when booking", async () => {
    const bookInspection = jest.fn<BusinessManagerClient["bookInspection"]>()
      .mockResolvedValue({ booking: { bookingId: "booking-1" } });
    const client = { bookInspection } as unknown as BusinessManagerClient;
    const tool = createRealEstateTools(client).find(({ definition }) =>
      definition.name === "bookInspection");
    const confirmedStartsAt = "2026-09-07T00:30:00.000Z";

    await tool?.execute(tool.inputSchema.parse({
      propertyId: "10000000-0000-4000-8000-000000000001",
      slotId: "20000000-0000-4000-8000-000000000001",
      confirmedStartsAt,
      customerName: "Jordan Lee",
      customerEmail: "jordan@example.com",
      confirmed: true,
    }), { customerId: "customer-1", sessionId: "session-1" });

    expect(bookInspection).toHaveBeenCalledWith(expect.objectContaining({
      confirmedStartsAt,
      idempotencyKey: "session-1:20000000-0000-4000-8000-000000000001:jordan@example.com",
    }));
  });
});
