import { z } from "zod";
import type { RuntimeTool } from "../../tools/tool-registry.js";
import { BusinessManagerClient } from "../../business-packs/real-estate/business-manager.client.js";
import { MemoryActionReviewStore, type ActionReviewStore } from "../../tools/action-review.store.js";
import { SafeToolOutputSchema, toolPolicy } from "../../tools/tool-policy.js";
import type { RuntimeToolPolicy } from "../../tools/tool-registry.js";

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

export function createLegacyRealEstateToolAdapter(client: BusinessManagerClient, reviews: ActionReviewStore = new MemoryActionReviewStore()): RuntimeTool<any, unknown>[] {

  const tools: RuntimeTool<any, unknown>[] = [
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
      definition: { name: "reviewInspectionBooking", description: "Display the customer's name, email, selected property and inspection time for review. This is mandatory before bookInspection. After displaying it, ask the customer to check every detail, especially the email spelling, and use the on-screen confirmation button.", parameters: { type: "object", additionalProperties: false, properties: {
        propertyId: { type: "string" }, slotId: { type: "string" }, confirmedStartsAt: { type: "string" }, propertyAddress: { type: "string" }, startsAtLabel: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" },
      }, required: ["propertyId", "slotId", "confirmedStartsAt", "propertyAddress", "startsAtLabel", "customerName", "customerEmail"] } },
      inputSchema: z.object({ propertyId: z.string().uuid(), slotId: z.string().uuid(), confirmedStartsAt: z.string().datetime({ offset: true }), propertyAddress: z.string().trim().min(3).max(240), startsAtLabel: z.string().trim().min(3).max(100), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254) }),
      execute: async (input, context) => {
        const review = await reviews.create(reviewContext(context), "inspection.booking", bookingReviewPayload(input));
        return { bookingReview: { ...input, mode: "new", ...publicReview(review) } };
      },
    },
    {
      definition: { name: "bookInspection", description: "Book a selected inspection only after the authenticated client confirms the displayed property, time, name and email. A model-provided confirmed value alone is insufficient. Copy confirmedStartsAt exactly from the selected slot's startsAt value. For a BUY property, pending_report means the booking is confirmed and the report is being prepared for the confirmation email; do not imply the email has already been sent. For RENT, use the returned email status. Always speak the authoritative propertyAddress, startsAtLabel and customerEmail exactly as returned.", parameters: { type: "object", additionalProperties: false, properties: {
        reviewId: { type: "string" }, propertyId: { type: "string" }, slotId: { type: "string" }, confirmedStartsAt: { type: "string", description: "The selected slot's exact startsAt ISO timestamp." }, propertyAddress: { type: "string" }, startsAtLabel: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" }, customerPhone: { type: "string" }, confirmed: { type: "boolean", description: "Must be true only after explicit customer confirmation." },
      }, required: ["reviewId", "propertyId", "slotId", "confirmedStartsAt", "propertyAddress", "startsAtLabel", "customerName", "customerEmail", "confirmed"] } },
      inputSchema: z.object({ reviewId: z.string().uuid(), propertyId: z.string().uuid(), slotId: z.string().uuid(), confirmedStartsAt: z.string().datetime({ offset: true }), propertyAddress: z.string().trim().min(3).max(240), startsAtLabel: z.string().trim().min(3).max(100), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254), customerPhone: optional(z.string().trim().max(40)), confirmed: z.literal(true) }),
      execute: async (input, context) => {
        const commandId = context.commandId ?? await reviews.consume(reviewContext(context), input.reviewId, "inspection.booking", bookingReviewPayload(input));
        const workflowVersionId = context.workflowVersions?.find(
          (binding) => binding.templateKey === "real-estate.sale-property-report",
        )?.workflowVersionId;
        return client.bookInspection({ ...input, idempotencyKey: `sophia:${commandId}`,
          ...(workflowVersionId ? { workflowVersionId } : {}) });
      },
    },
    {
      definition: { name: "reviewInspectionEmailResend", description: "Display an existing booking and a corrected recipient email for review before resending. Ask the customer to check the corrected email spelling and use the on-screen confirmation button.", parameters: { type: "object", additionalProperties: false, properties: { bookingId: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" }, propertyAddress: { type: "string" }, startsAtLabel: { type: "string" } }, required: ["bookingId", "customerName", "customerEmail", "propertyAddress", "startsAtLabel"] } },
      inputSchema: z.object({ bookingId: z.string().uuid(), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254), propertyAddress: z.string().trim().min(3).max(240), startsAtLabel: z.string().trim().min(3).max(100) }),
      execute: async (input, context) => {
        const review = await reviews.create(reviewContext(context), "inspection.resend", resendReviewPayload(input));
        return { bookingReview: { ...input, mode: "resend", ...publicReview(review) } };
      },
    },
    {
      definition: { name: "resendInspectionConfirmation", description: "Save a corrected inspection-confirmation email and resend only after reviewInspectionEmailResend has displayed the details and the customer has explicitly confirmed them. For BUY bookings, the response may be pending_report while the PDF is prepared or queued when the report is ready.", parameters: { type: "object", additionalProperties: false, properties: { reviewId: { type: "string" }, bookingId: { type: "string" }, customerName: { type: "string" }, customerEmail: { type: "string" }, propertyAddress: { type: "string" }, startsAtLabel: { type: "string" }, confirmed: { type: "boolean" } }, required: ["reviewId", "bookingId", "customerName", "customerEmail", "propertyAddress", "startsAtLabel", "confirmed"] } },
      inputSchema: z.object({ reviewId: z.string().uuid(), bookingId: z.string().uuid(), customerName: z.string().trim().min(2).max(120), customerEmail: z.string().email().max(254), propertyAddress: z.string().trim().min(3).max(240), startsAtLabel: z.string().trim().min(3).max(100), confirmed: z.literal(true) }),
      execute: async (input, context) => {
        const commandId = context.commandId ?? await reviews.consume(reviewContext(context), input.reviewId, "inspection.resend", resendReviewPayload(input));
        return client.resendInspectionConfirmation({ ...input, idempotencyKey: `sophia:${commandId}` });
      },
    },
    {
      definition: { name: "searchAgencyKnowledge", description: "Search and display agency-approved real-estate requirements, property documents, rental applications, leases and selling guidance. Choose renting for rent, rental, tenant, lease or application questions; choose selling for sale, seller or vendor questions.", parameters: { type: "object", additionalProperties: false, properties: { q: { type: "string" }, category: { type: "string", enum: ["renting", "selling", "inspections", "general"] } }, required: ["q"] } },
      inputSchema: z.object({ q: z.string().trim().min(2).max(240), category: optional(z.enum(["renting", "selling", "inspections", "general"])) }),
      execute: (input) => client.searchKnowledge(input),
    },
  ];
  for (const tool of tools) {
    tool.outputSchema = SafeToolOutputSchema;
    tool.policy = REAL_ESTATE_TOOL_POLICIES[tool.definition.name];
    if (!tool.policy) throw new Error(`Missing runtime policy for ${tool.definition.name}.`);
    if (tool.definition.name === "bookInspection") {
      tool.reviewAuthorization = { mode: "inspection.booking", payload: bookingReviewPayload };
    }
    if (tool.definition.name === "resendInspectionConfirmation") {
      tool.reviewAuthorization = { mode: "inspection.resend", payload: resendReviewPayload };
    }
  }
  return tools;
}

const REAL_ESTATE_TOOL_POLICIES: Record<string, RuntimeToolPolicy> = {
  searchProperties: toolPolicy({ toolId: "catalog.search", requiredCapability: "catalog", sideEffectClass: "read" }),
  getPropertyDetails: toolPolicy({ toolId: "catalog.get", requiredCapability: "catalog", sideEffectClass: "read" }),
  showPropertyPhoto: toolPolicy({ toolId: "catalog.media", requiredCapability: "catalog", sideEffectClass: "read" }),
  closePropertyView: toolPolicy({ toolId: "ui.dismiss", requiredCapability: "presentation", sideEffectClass: "ephemeral-ui" }),
  getInspectionSlots: toolPolicy({ toolId: "availability.search", requiredCapability: "availability", sideEffectClass: "read" }),
  reviewInspectionBooking: toolPolicy({ toolId: "booking.prepare", requiredCapability: "booking", sideEffectClass: "prepare-command" }),
  bookInspection: toolPolicy({ toolId: "booking.commit", requiredCapability: "booking", sideEffectClass: "business-mutation" }),
  reviewInspectionEmailResend: toolPolicy({ toolId: "delivery.prepare-resend", requiredCapability: "delivery", sideEffectClass: "prepare-command" }),
  resendInspectionConfirmation: toolPolicy({ toolId: "delivery.commit-resend", requiredCapability: "delivery", sideEffectClass: "notification" }),
  searchAgencyKnowledge: toolPolicy({ toolId: "knowledge.search", requiredCapability: "knowledge", sideEffectClass: "read" }),
};

function reviewContext(context: { sessionId?: string; customerId: string }) {
  if (!context.sessionId) throw new Error("An authorised session is required for this action.");
  return { sessionId: context.sessionId, customerId: context.customerId };
}

function bookingReviewPayload(input: Record<string, unknown>) {
  return {
    propertyId: input["propertyId"],
    slotId: input["slotId"],
    confirmedStartsAt: input["confirmedStartsAt"],
    propertyAddress: String(input["propertyAddress"] || "").trim(),
    startsAtLabel: String(input["startsAtLabel"] || "").trim(),
    customerName: String(input["customerName"] || "").trim(),
    customerEmail: String(input["customerEmail"] || "").trim().toLowerCase(),
  };
}

function resendReviewPayload(input: Record<string, unknown>) {
  return {
    bookingId: input["bookingId"],
    customerName: String(input["customerName"] || "").trim(),
    customerEmail: String(input["customerEmail"] || "").trim().toLowerCase(),
    propertyAddress: String(input["propertyAddress"] || "").trim(),
    startsAtLabel: String(input["startsAtLabel"] || "").trim(),
  };
}

function publicReview(review: { reviewId: string; expiresAt: string }) {
  return { reviewId: review.reviewId, expiresAt: review.expiresAt };
}
