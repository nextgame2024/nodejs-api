import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";
import { BusinessManagerClient } from "./business-manager.client.js";

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

export function createRealEstateTools(client: BusinessManagerClient): RuntimeTool<any, unknown>[] {
  const pendingReviews = new Map<string, { mode: "new" | "resend"; input: Record<string, unknown> }>();
  const reviewKey = (sessionId?: string) => sessionId || "missing-session";

  return [
    {
      definition: {
        name: "searchProperties",
        description: "Search the agency's current sale or rental properties. Use location when the user gives a general place. Use city and suburb together only when both are explicit. Return no more than three relevant options.",
        parameters: { type: "object", additionalProperties: false, properties: {
          listingType: { type: "string", enum: ["sale", "rent"] }, propertyType: { type: "string" },
          location: { type: "string", description: "General city or suburb filter, for example Brisbane or Bulimba." },
          city: { type: "string", description: "City or municipality, for example Brisbane." },
          suburb: { type: "string", description: "Local suburb, for example Bulimba or Newstead." },
          minBedrooms: { type: "integer" }, maxPrice: { type: "integer" },
        } },
      },
      inputSchema: z.object({ listingType: optional(z.enum(["sale", "rent"])), propertyType: optional(z.string().trim().min(2).max(80)), location: optional(z.string().trim().min(2).max(100)), city: optional(z.string().trim().min(2).max(100)), suburb: optional(z.string().trim().min(2).max(100)), minBedrooms: optional(z.number().int().min(0).max(20)), maxPrice: optional(z.number().int().positive().max(100_000_000)) }),
      execute: (input) => client.searchProperties({ ...input, limit: 3 }),
    },
    {
      definition: { name: "getPropertyDetails", description: "Get complete details and ordered photos for one agency property.", parameters: { type: "object", additionalProperties: false, properties: { propertyId: { type: "string" } }, required: ["propertyId"] } },
      inputSchema: z.object({ propertyId: z.string().uuid() }),
      execute: ({ propertyId }) => client.getProperty(propertyId),
    },
    {
      definition: { name: "showPropertyPhoto", description: "Open one selected property photo in the large on-screen viewer. Use photoNumber 1, 2 or 3 when the customer identifies a photo; default to 1.", parameters: { type: "object", additionalProperties: false, properties: { propertyId: { type: "string" }, photoNumber: { type: "integer", minimum: 1, maximum: 3 } }, required: ["propertyId"] } },
      inputSchema: z.object({ propertyId: z.string().uuid(), photoNumber: optional(z.number().int().min(1).max(3)) }),
      execute: async ({ propertyId, photoNumber }) => {
        const result = await client.getProperty(propertyId) as Record<string, unknown>;
        return { ...result, photoNumber: photoNumber ?? 1, display: "photo_viewer" };
      },
    },
    {
      definition: { name: "closePropertyView", description: "Close the on-screen property photo, property results, inspection times, booking or requirements view when the customer asks to close it or go back.", parameters: { type: "object", additionalProperties: false, properties: {} } },
      inputSchema: z.object({}),
      execute: async () => ({ closePropertyView: true }),
    },
    {
      definition: { name: "getInspectionSlots", description: "Get available inspection times for a property over the next two weeks. Offer each startsAtLabel exactly as returned and retain its corresponding slotId and startsAt values for booking.", parameters: { type: "object", additionalProperties: false, properties: { propertyId: { type: "string" } }, required: ["propertyId"] } },
      inputSchema: z.object({ propertyId: z.string().uuid() }),
      execute: ({ propertyId }) => client.getInspectionSlots(propertyId, {}),
    },
    {
      definition: { name: "reviewInspectionBooking", description: "Display the customer's name, email, selected property and inspection time for review. This is mandatory before bookInspection. After displaying it, ask the customer to confirm that every detail, especially the email spelling, is correct.", parameters: { type: "object", additionalProperties: false, properties: {
        propertyId: { type: "string" }, slotId: { type: "string" }, confirmedStartsAt: { type: "string" }, propertyAddress: { type: "string" }, startsAtLabel: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" },
      }, required: ["propertyId", "slotId", "confirmedStartsAt", "propertyAddress", "startsAtLabel", "customerName", "customerEmail"] } },
      inputSchema: z.object({ propertyId: z.string().uuid(), slotId: z.string().uuid(), confirmedStartsAt: z.string().datetime({ offset: true }), propertyAddress: z.string().trim().min(3).max(240), startsAtLabel: z.string().trim().min(3).max(100), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254) }),
      execute: async (input, context) => {
        pendingReviews.set(reviewKey(context.sessionId), { mode: "new", input });
        return { bookingReview: { ...input, mode: "new" } };
      },
    },
    {
      definition: { name: "bookInspection", description: "Book a selected inspection only after the customer explicitly confirms the property, time, name and email. Copy confirmedStartsAt exactly from the selected slot's startsAt value. After success, speak the authoritative propertyAddress, startsAtLabel, customerEmail and confirmation-email status exactly as returned; never calculate or convert the time.", parameters: { type: "object", additionalProperties: false, properties: {
        propertyId: { type: "string" }, slotId: { type: "string" }, confirmedStartsAt: { type: "string", description: "The selected slot's exact startsAt ISO timestamp." }, customerName: { type: "string" }, customerEmail: { type: "string" }, customerPhone: { type: "string" }, confirmed: { type: "boolean", description: "Must be true only after explicit customer confirmation." },
      }, required: ["propertyId", "slotId", "confirmedStartsAt", "customerName", "customerEmail", "confirmed"] } },
      inputSchema: z.object({ propertyId: z.string().uuid(), slotId: z.string().uuid(), confirmedStartsAt: z.string().datetime({ offset: true }), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254), customerPhone: optional(z.string().trim().max(40)), confirmed: z.literal(true) }),
      execute: async (input, context) => {
        const key = reviewKey(context.sessionId);
        const review = pendingReviews.get(key);
        if (
          review?.mode !== "new" ||
          review.input["propertyId"] !== input.propertyId ||
          review.input["slotId"] !== input.slotId ||
          review.input["confirmedStartsAt"] !== input.confirmedStartsAt ||
          review.input["customerName"] !== input.customerName ||
          String(review.input["customerEmail"]).toLowerCase() !== input.customerEmail.toLowerCase()
        ) {
          throw new Error("Display and confirm the booking details before booking and sending email.");
        }
        pendingReviews.delete(key);
        return client.bookInspection({ ...input, idempotencyKey: `${context.sessionId || "session"}:${input.slotId}:${input.customerEmail.toLowerCase()}` });
      },
    },
    {
      definition: { name: "reviewInspectionEmailResend", description: "Display an existing booking and a corrected recipient email for review before resending. After displaying it, ask the customer to confirm the corrected email spelling.", parameters: { type: "object", additionalProperties: false, properties: { bookingId: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" }, propertyAddress: { type: "string" }, startsAtLabel: { type: "string" } }, required: ["bookingId", "customerName", "customerEmail", "propertyAddress", "startsAtLabel"] } },
      inputSchema: z.object({ bookingId: z.string().uuid(), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254), propertyAddress: z.string().trim().min(3).max(240), startsAtLabel: z.string().trim().min(3).max(100) }),
      execute: async (input, context) => {
        pendingReviews.set(reviewKey(context.sessionId), { mode: "resend", input });
        return { bookingReview: { ...input, mode: "resend" } };
      },
    },
    {
      definition: { name: "resendInspectionConfirmation", description: "Resend an inspection confirmation to a corrected email only after reviewInspectionEmailResend has displayed the details and the customer has explicitly confirmed them.", parameters: { type: "object", additionalProperties: false, properties: { bookingId: { type: "string" }, customerEmail: { type: "string" }, confirmed: { type: "boolean" } }, required: ["bookingId", "customerEmail", "confirmed"] } },
      inputSchema: z.object({ bookingId: z.string().uuid(), customerEmail: z.string().email().max(254), confirmed: z.literal(true) }),
      execute: async (input, context) => {
        const key = reviewKey(context.sessionId);
        const review = pendingReviews.get(key);
        if (
          review?.mode !== "resend" ||
          review.input["bookingId"] !== input.bookingId ||
          String(review.input["customerEmail"]).toLowerCase() !== input.customerEmail.toLowerCase()
        ) {
          throw new Error("Display and confirm the corrected email before resending.");
        }
        pendingReviews.delete(key);
        return client.resendInspectionConfirmation(input);
      },
    },
    {
      definition: { name: "searchAgencyKnowledge", description: "Search and display agency-approved rental and selling requirements. You must use this for questions about requirements, documents, applications, leases or selling. Choose renting for rent, rental, tenant, lease or application questions; choose selling for sale, seller or vendor questions.", parameters: { type: "object", additionalProperties: false, properties: { q: { type: "string" }, category: { type: "string", enum: ["renting", "selling", "inspections", "general"] } }, required: ["q"] } },
      inputSchema: z.object({ q: z.string().trim().min(2).max(240), category: optional(z.enum(["renting", "selling", "inspections", "general"])) }),
      execute: async (input) => {
        try {
          const response = await client.searchKnowledge(input);
          const results = recordValue(response)?.["results"];
          if (Array.isArray(results) && results.length) return response;
        } catch {
          // Keep the approved demo guidance available if Business Manager is temporarily unavailable.
        }
        return { results: fallbackAgencyKnowledge(input.q, input.category), source: "demo_fallback" };
      },
    },
  ];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function fallbackAgencyKnowledge(query: string, category?: string) {
  const normalized = `${category || ""} ${query}`.toLowerCase();
  if (/sell|sale|seller|vendor/.test(normalized)) {
    return [
      {
        knowledgeId: "demo-selling-requirements",
        category: "selling",
        question: "What should I prepare to sell a property?",
        answer: "Prepare proof of identity and ownership, the property and title details, the written agent appointment covering commission and marketing costs, and the required Queensland seller disclosure documents. The agency will confirm the exact documents for the property.",
        jurisdiction: "Queensland, Australia",
      },
      {
        knowledgeId: "demo-selling-disclosure",
        category: "selling",
        question: "What seller disclosure information may be required?",
        answer: "Common items include the Seller Disclosure Statement Form 2, a current title search and survey plan, applicable notices and certificates, and body corporate records when the property is in a community titles scheme.",
        jurisdiction: "Queensland, Australia",
      },
    ];
  }
  return [
    {
      knowledgeId: "demo-renting-application",
      category: "renting",
      question: "What should I prepare for a rental application?",
      answer: "Prepare your contact, employment, income, rental-history and referee details, plus information about the intended tenancy, occupants, vehicles and pets. Each applicant should complete the agency's rental application.",
      jurisdiction: "Queensland, Australia",
    },
    {
      knowledgeId: "demo-renting-documents",
      category: "renting",
      question: "Which supporting documents are commonly requested?",
      answer: "Common documents include identification such as a driver licence or passport, evidence of ability to pay such as recent payslips or an employment contract, and suitability evidence such as rental references, a rental ledger or tenancy history.",
      jurisdiction: "Queensland, Australia",
    },
  ];
}
