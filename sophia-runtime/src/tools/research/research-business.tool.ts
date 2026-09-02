import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";
import type {
  BusinessResearchRequest,
  BusinessResearchResult,
  BusinessResearchService,
} from "./business-research.service.js";

const inputSchema = z.object({
  businessName: z.string().trim().min(2).max(160),
  location: z.string().trim().min(2).max(160).optional(),
});

export function createResearchBusinessTool(
  research: BusinessResearchService,
): RuntimeTool<BusinessResearchRequest, BusinessResearchResult> {
  return {
    definition: {
      name: "researchBusiness",
      description:
        "Research current public information about a named business. Use this whenever a user asks about a specific business, company, venue, restaurant, or organisation. Prefer its official website and include a location when known.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          businessName: {
            type: "string",
            description: "The business or organisation name.",
          },
          location: {
            type: "string",
            description:
              "Optional city, region, country, or address used to disambiguate the business.",
          },
        },
        required: ["businessName"],
      },
    },
    inputSchema,
    execute: (input) => research.research(input),
  };
}
