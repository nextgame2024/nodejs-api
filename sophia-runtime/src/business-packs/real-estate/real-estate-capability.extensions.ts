import { z } from "zod";
import type { CapabilityExtensionDefinition } from "../../capabilities-v2/extensions/capability-extension.registry.js";

const moneyRange = z.object({
  minimum: z.number().nonnegative().optional(),
  maximum: z.number().nonnegative().optional(),
}).strict().refine((value) => value.minimum === undefined || value.maximum === undefined || value.maximum >= value.minimum, {
  message: "Maximum price must not be lower than minimum price.",
  path: ["maximum"],
});

const listingSummary = z.object({
  listingType: z.enum(["sale", "rent"]),
  suburb: z.string().trim().min(1).max(120).optional(),
  displayPrice: z.string().trim().min(1).max(120).optional(),
  bedrooms: z.number().int().nonnegative().optional(),
  bathrooms: z.number().int().nonnegative().optional(),
  carSpaces: z.number().int().nonnegative().optional(),
}).strict();

export function realEstateCapabilityExtensions(
  capabilityBindingId: string,
): CapabilityExtensionDefinition[] {
  return [
    {
      capabilityBindingId,
      operationId: "catalog.search",
      metadata: {
        schemaId: "real-estate.catalog-search-extension",
        schemaVersion: "1.0.0",
        dataClassification: ["public"],
        maximumItems: 25,
      },
      inputSchema: z.object({
        listingType: z.enum(["sale", "rent"]).optional(),
        suburbs: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
        priceRange: moneyRange.optional(),
        minimumBedrooms: z.number().int().nonnegative().max(100).optional(),
      }).strict(),
      outputSchema: listingSummary,
    },
    {
      capabilityBindingId,
      operationId: "catalog.get",
      metadata: {
        schemaId: "real-estate.catalog-detail-extension",
        schemaVersion: "1.0.0",
        dataClassification: ["public"],
      },
      inputSchema: z.object({}).strict(),
      outputSchema: listingSummary.extend({
        description: z.string().trim().max(10_000).optional(),
        features: z.array(z.string().trim().min(1).max(200)).max(100),
      }).strict(),
    },
    {
      capabilityBindingId,
      operationId: "catalog.media",
      metadata: {
        schemaId: "real-estate.catalog-media-extension",
        schemaVersion: "1.0.0",
        dataClassification: ["public"],
        maximumItems: 50,
      },
      inputSchema: z.object({ selectedIndex: z.number().int().nonnegative().optional() }).strict(),
      outputSchema: z.object({
        roomLabel: z.string().trim().max(120).optional(),
        displayOrder: z.number().int().nonnegative().optional(),
      }).strict(),
    },
    {
      capabilityBindingId,
      operationId: "availability.search",
      metadata: {
        schemaId: "real-estate.availability-extension",
        schemaVersion: "1.0.0",
        dataClassification: ["public"],
        maximumItems: 30,
      },
      inputSchema: z.object({ inspectionType: z.enum(["open", "private"]).optional() }).strict(),
      outputSchema: z.object({ inspectionType: z.enum(["open", "private"]) }).strict(),
    },
  ];
}
