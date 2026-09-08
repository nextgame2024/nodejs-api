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

  it("returns an on-screen booking review without creating the booking", async () => {
    const client = {} as BusinessManagerClient;
    const tool = createRealEstateTools(client).find(({ definition }) =>
      definition.name === "reviewInspectionBooking");

    const output = await tool?.execute(tool.inputSchema.parse({
      propertyId: "10000000-0000-4000-8000-000000000001",
      slotId: "20000000-0000-4000-8000-000000000001",
      confirmedStartsAt: "2026-09-11T00:30:00.000Z",
      startsAtLabel: "Fri, 11 Sept, 10:30 am",
      propertyAddress: "7/30 Sandgate Road, Clayfield",
      customerName: "Jose",
      customerEmail: "jlcm66@gmail.com",
    }), { customerId: "customer-1" });

    expect(output).toEqual(expect.objectContaining({
      bookingReview: expect.objectContaining({
        mode: "new",
        customerEmail: "jlcm66@gmail.com",
      }),
    }));
  });

  it("requires explicit confirmation before resending an email", () => {
    const client = {} as BusinessManagerClient;
    const tool = createRealEstateTools(client).find(({ definition }) =>
      definition.name === "resendInspectionConfirmation");

    expect(() => tool?.inputSchema.parse({
      bookingId: "30000000-0000-4000-8000-000000000001",
      customerEmail: "jlcm66@gmail.com",
      confirmed: false,
    })).toThrow();
  });

  it("passes the selected slot timestamp through when booking", async () => {
    const bookInspection = jest.fn<BusinessManagerClient["bookInspection"]>()
      .mockResolvedValue({ booking: { bookingId: "booking-1" } });
    const client = { bookInspection } as unknown as BusinessManagerClient;
    const tools = createRealEstateTools(client);
    const reviewTool = tools.find(({ definition }) =>
      definition.name === "reviewInspectionBooking");
    const tool = tools.find(({ definition }) =>
      definition.name === "bookInspection");
    const confirmedStartsAt = "2026-09-07T00:30:00.000Z";

    await reviewTool?.execute(reviewTool.inputSchema.parse({
      propertyId: "10000000-0000-4000-8000-000000000001",
      slotId: "20000000-0000-4000-8000-000000000001",
      confirmedStartsAt,
      propertyAddress: "18 Jacaranda Street, Bulimba",
      startsAtLabel: "Mon, 7 Sept, 10:30 am",
      customerName: "Jordan Lee",
      customerEmail: "jordan@example.com",
    }), { customerId: "customer-1", sessionId: "session-1" });

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

  it("blocks booking when the displayed email does not match", async () => {
    const bookInspection = jest.fn<BusinessManagerClient["bookInspection"]>();
    const tools = createRealEstateTools({ bookInspection } as unknown as BusinessManagerClient);
    const review = tools.find(({ definition }) => definition.name === "reviewInspectionBooking")!;
    const book = tools.find(({ definition }) => definition.name === "bookInspection")!;
    const common = {
      propertyId: "10000000-0000-4000-8000-000000000001",
      slotId: "20000000-0000-4000-8000-000000000001",
      confirmedStartsAt: "2026-09-07T00:30:00.000Z",
      propertyAddress: "18 Jacaranda Street, Bulimba",
      startsAtLabel: "Mon, 7 Sept, 10:30 am",
      customerName: "Jordan Lee",
    };

    await review.execute(review.inputSchema.parse({
      ...common,
      customerEmail: "wrong@example.com",
    }), { customerId: "customer-1", sessionId: "session-2" });

    await expect(book.execute(book.inputSchema.parse({
      ...common,
      customerEmail: "correct@example.com",
      confirmed: true,
    }), { customerId: "customer-1", sessionId: "session-2" })).rejects.toThrow(
      "Display and confirm",
    );
    expect(bookInspection).not.toHaveBeenCalled();
  });

  it("returns approved demo requirements when Business Manager knowledge fails", async () => {
    const searchKnowledge = jest.fn<BusinessManagerClient["searchKnowledge"]>()
      .mockRejectedValue(new Error("Business Manager unavailable"));
    const tools = createRealEstateTools({ searchKnowledge } as unknown as BusinessManagerClient);
    const tool = tools.find(({ definition }) => definition.name === "searchAgencyKnowledge")!;

    const output = await tool.execute(tool.inputSchema.parse({
      q: "What documents do I need to rent a property?",
      category: "renting",
    }), { customerId: "customer-1", sessionId: "session-3" });

    expect(output).toEqual(expect.objectContaining({
      source: "demo_fallback",
      results: expect.arrayContaining([
        expect.objectContaining({ category: "renting" }),
      ]),
    }));
  });
});
