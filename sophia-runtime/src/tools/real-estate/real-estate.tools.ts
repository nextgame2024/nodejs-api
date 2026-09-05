import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";
import { BusinessManagerClient } from "./business-manager.client.js";

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

export function createRealEstateTools(client: BusinessManagerClient): RuntimeTool<any, unknown>[] {
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
      definition: { name: "getInspectionSlots", description: "Get available inspection times for a property over the next two weeks. Offer each startsAtLabel exactly as returned and retain its corresponding slotId and startsAt values for booking.", parameters: { type: "object", additionalProperties: false, properties: { propertyId: { type: "string" } }, required: ["propertyId"] } },
      inputSchema: z.object({ propertyId: z.string().uuid() }),
      execute: ({ propertyId }) => client.getInspectionSlots(propertyId, {}),
    },
    {
      definition: { name: "bookInspection", description: "Book a selected inspection only after the customer explicitly confirms the property, time, name and email. Copy confirmedStartsAt exactly from the selected slot's startsAt value. After success, speak the authoritative propertyAddress and startsAtLabel exactly as returned; never calculate or convert the time.", parameters: { type: "object", additionalProperties: false, properties: {
        propertyId: { type: "string" }, slotId: { type: "string" }, confirmedStartsAt: { type: "string", description: "The selected slot's exact startsAt ISO timestamp." }, customerName: { type: "string" }, customerEmail: { type: "string" }, customerPhone: { type: "string" }, confirmed: { type: "boolean", description: "Must be true only after explicit customer confirmation." },
      }, required: ["propertyId", "slotId", "confirmedStartsAt", "customerName", "customerEmail", "confirmed"] } },
      inputSchema: z.object({ propertyId: z.string().uuid(), slotId: z.string().uuid(), confirmedStartsAt: z.string().datetime({ offset: true }), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254), customerPhone: optional(z.string().trim().max(40)), confirmed: z.literal(true) }),
      execute: (input, context) => client.bookInspection({ ...input, idempotencyKey: `${context.sessionId || "session"}:${input.slotId}:${input.customerEmail.toLowerCase()}` }),
    },
    {
      definition: { name: "searchAgencyKnowledge", description: "Search agency-approved rental and selling requirements. Use this before answering process or document questions.", parameters: { type: "object", additionalProperties: false, properties: { q: { type: "string" }, category: { type: "string" } }, required: ["q"] } },
      inputSchema: z.object({ q: z.string().trim().min(2).max(240), category: optional(z.string().trim().min(2).max(80)) }),
      execute: (input) => client.searchKnowledge(input),
    },
  ];
}
