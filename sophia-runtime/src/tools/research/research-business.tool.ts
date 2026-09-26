import { z } from "zod";
import type { RuntimeTool } from "../tool-registry.js";
import type { BusinessResearchRequest, BusinessResearchResult } from "./business-research.service.js";
import { SafeToolOutputSchema, toolPolicy } from "../tool-policy.js";

export interface BusinessResearchCapability {
  research(request: BusinessResearchRequest): Promise<BusinessResearchResult>;
}

const inputSchema = z.object({
  businessName: z.string().trim().min(2).max(160),
  location: z.string().trim().min(2).max(160).optional(),
});

export function createResearchBusinessTool(
  research: BusinessResearchCapability,
): RuntimeTool<BusinessResearchRequest, BusinessResearchResult> {
  return {
    definition: {
      name: "researchBusiness",
      description:
        "Research current public information about a named business. Use this whenever a user asks about a specific business, company, venue, restaurant, or organisation. Prefer its official website and include a location when known. If the result status is unavailable, explain that current web research is temporarily unavailable and do not retry in the same turn.",
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
    outputSchema: SafeToolOutputSchema as z.ZodType<BusinessResearchResult>,
    policy: toolPolicy({
      toolId: "research.public",
      requiredCapability: "research",
      sideEffectClass: "read",
      retryPolicy: "none",
      timeoutMs: 45_000,
    }),
    execute: (input) => research.research(input),
  };
}
