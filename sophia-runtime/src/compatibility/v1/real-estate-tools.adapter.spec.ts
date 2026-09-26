import { describe, expect, it, jest } from "@jest/globals";
import { BusinessManagerClient } from "../../business-packs/real-estate/business-manager.client.js";
import { createLegacyRealEstateToolAdapter as createRealEstateTools } from "./real-estate-tools.adapter.js";
import { MemoryActionReviewStore } from "../../tools/action-review.store.js";

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
    }), { customerId: "customer-1", sessionId: "session-review" });

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
    const reviews = new MemoryActionReviewStore();
    const tools = createRealEstateTools(client, reviews);
    const reviewTool = tools.find(({ definition }) =>
      definition.name === "reviewInspectionBooking");
    const tool = tools.find(({ definition }) =>
      definition.name === "bookInspection");
    const confirmedStartsAt = "2026-09-07T00:30:00.000Z";

    const reviewed = await reviewTool?.execute(reviewTool.inputSchema.parse({
      propertyId: "10000000-0000-4000-8000-000000000001",
      slotId: "20000000-0000-4000-8000-000000000001",
      confirmedStartsAt,
      propertyAddress: "18 Jacaranda Street, Bulimba",
      startsAtLabel: "Mon, 7 Sept, 10:30 am",
      customerName: "Jordan Lee",
      customerEmail: "jordan@example.com",
    }), { customerId: "customer-1", sessionId: "session-1" });
    const reviewId = (reviewed as any).bookingReview.reviewId;
    await reviews.confirm({ customerId: "customer-1", sessionId: "session-1" }, reviewId);

    await tool?.execute(tool.inputSchema.parse({
      reviewId,
      propertyId: "10000000-0000-4000-8000-000000000001",
      slotId: "20000000-0000-4000-8000-000000000001",
      confirmedStartsAt,
      propertyAddress: "18 Jacaranda Street, Bulimba",
      startsAtLabel: "Mon, 7 Sept, 10:30 am",
      customerName: "Jordan Lee",
      customerEmail: "jordan@example.com",
      confirmed: true,
    }), { customerId: "customer-1", sessionId: "session-1", workflowVersions: [{
      templateKey: "real-estate.sale-property-report",
      workflowVersionId: "60000000-0000-4000-8000-000000000001",
    }] });

    expect(bookInspection).toHaveBeenCalledWith(expect.objectContaining({
      confirmedStartsAt,
      idempotencyKey: expect.stringMatching(/^sophia:/),
      workflowVersionId: "60000000-0000-4000-8000-000000000001",
    }));
  });

  it("blocks booking when the displayed email does not match", async () => {
    const bookInspection = jest.fn<BusinessManagerClient["bookInspection"]>();
    const reviews = new MemoryActionReviewStore();
    const tools = createRealEstateTools({ bookInspection } as unknown as BusinessManagerClient, reviews);
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

    const reviewed = await review.execute(review.inputSchema.parse({
      ...common,
      customerEmail: "wrong@example.com",
    }), { customerId: "customer-1", sessionId: "session-2" });
    const reviewId = (reviewed as any).bookingReview.reviewId;
    await reviews.confirm({ customerId: "customer-1", sessionId: "session-2" }, reviewId);

    await expect(book.execute(book.inputSchema.parse({
      ...common,
      reviewId,
      customerEmail: "correct@example.com",
      confirmed: true,
    }), { customerId: "customer-1", sessionId: "session-2" })).rejects.toThrow(
      "Display and explicitly confirm",
    );
    expect(bookInspection).not.toHaveBeenCalled();
  });

  it("fails closed instead of substituting hardcoded agency knowledge", async () => {
    const searchKnowledge = jest.fn<BusinessManagerClient["searchKnowledge"]>()
      .mockRejectedValue(new Error("Business Manager unavailable"));
    const tools = createRealEstateTools({ searchKnowledge } as unknown as BusinessManagerClient);
    const tool = tools.find(({ definition }) => definition.name === "searchAgencyKnowledge")!;

    await expect(tool.execute(tool.inputSchema.parse({
      q: "What documents do I need to rent a property?",
      category: "renting",
    }), { customerId: "customer-1", sessionId: "session-3" })).rejects.toThrow("Business Manager unavailable");
  });
});

it("keeps a durable review usable across tool factory recreation",async()=>{
  const bookInspection=jest.fn<BusinessManagerClient["bookInspection"]>().mockResolvedValue({});
  const reviews=new MemoryActionReviewStore();
  const review=createRealEstateTools({bookInspection} as unknown as BusinessManagerClient,reviews).find(t=>t.definition.name==="reviewInspectionBooking")!;
  const input={propertyId:"10000000-0000-4000-8000-000000000001",slotId:"20000000-0000-4000-8000-000000000001",confirmedStartsAt:"2026-09-20T00:30:00Z",propertyAddress:"Example property",startsAtLabel:"Example time",customerName:"Example",customerEmail:"example@example.com"};
  const reviewed=await review.execute(input,{customerId:"demo",sessionId:"session"}) as any;
  await reviews.confirm({customerId:"demo",sessionId:"session"},reviewed.bookingReview.reviewId);
  const book=createRealEstateTools({bookInspection} as unknown as BusinessManagerClient,reviews).find(t=>t.definition.name==="bookInspection")!;
  await book.execute({...input,reviewId:reviewed.bookingReview.reviewId,confirmed:true},{customerId:"demo",sessionId:"session"});
  expect(bookInspection).toHaveBeenCalledTimes(1);
});
