import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";
import { BusinessManagerClient } from "./business-manager.client.js";

export function createRealEstateTools(client: BusinessManagerClient): RuntimeTool<any, unknown>[] {
  return [
    {
      definition: {
        name: "searchProperties",
        description: "Search the agency's current sale or rental properties. Return no more than three relevant options.",
        parameters: { type: "object", additionalProperties: false, properties: {
          listingType: { type: "string", enum: ["sale", "rent"] }, propertyType: { type: "string" },
          suburb: { type: "string" }, minBedrooms: { type: "integer" }, maxPrice: { type: "integer" },
        } },
      },
      inputSchema: z.object({ listingType: z.enum(["sale", "rent"]).optional(), propertyType: z.string().trim().min(2).max(80).optional(), suburb: z.string().trim().min(2).max(100).optional(), minBedrooms: z.number().int().min(0).max(20).optional(), maxPrice: z.number().int().positive().max(100_000_000).optional() }),
      execute: (input) => client.searchProperties({ ...input, limit: 3 }),
    },
    {
      definition: { name: "getPropertyDetails", description: "Get complete details and ordered photos for one agency property.", parameters: { type: "object", additionalProperties: false, properties: { propertyId: { type: "string" } }, required: ["propertyId"] } },
      inputSchema: z.object({ propertyId: z.string().uuid() }),
      execute: ({ propertyId }) => client.getProperty(propertyId),
    },
    {
      definition: { name: "getInspectionSlots", description: "Get available inspection times for a property over the next two weeks.", parameters: { type: "object", additionalProperties: false, properties: { propertyId: { type: "string" } }, required: ["propertyId"] } },
      inputSchema: z.object({ propertyId: z.string().uuid() }),
      execute: ({ propertyId }) => client.getInspectionSlots(propertyId, {}),
    },
    {
      definition: { name: "bookInspection", description: "Book a selected inspection only after the customer explicitly confirms the property, time, name and email.", parameters: { type: "object", additionalProperties: false, properties: {
        propertyId: { type: "string" }, slotId: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" }, customerPhone: { type: "string" }, confirmed: { type: "boolean", description: "Must be true only after explicit customer confirmation." },
      }, required: ["propertyId", "slotId", "customerName", "customerEmail", "confirmed"] } },
      inputSchema: z.object({ propertyId: z.string().uuid(), slotId: z.string().uuid(), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254), customerPhone: z.string().trim().max(40).optional(), confirmed: z.literal(true) }),
      execute: (input, context) => client.bookInspection({ ...input, idempotencyKey: `${context.sessionId || "session"}:${input.slotId}:${input.customerEmail.toLowerCase()}` }),
    },
    {
      definition: { name: "searchAgencyKnowledge", description: "Search agency-approved rental and selling requirements. Use this before answering process or document questions.", parameters: { type: "object", additionalProperties: false, properties: { q: { type: "string" }, category: { type: "string" } }, required: ["q"] } },
      inputSchema: z.object({ q: z.string().trim().min(2).max(240), category: z.string().trim().min(2).max(80).optional() }),
      execute: (input) => client.searchKnowledge(input),
    },
  ];
}
