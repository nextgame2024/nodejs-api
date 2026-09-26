import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type { ConnectorCapabilityManifest } from "../../capabilities-v2/connectors/connector-capability.manifest.js";
import type {
  CapabilityContext,
  CommandReceipt,
  ExtensionValue,
  OperationStatus,
  SourceMetadata,
} from "../../capabilities-v2/contracts/business-capability.contracts.js";
import type {
  AvailabilityPort,
  BookingPort,
  CatalogPort,
  DeliveryPort,
  KnowledgePort,
  WorkflowStatusPort,
} from "../../capabilities-v2/ports/business-capability.ports.js";
import { PostgresActionReviewStore } from "../../tools/action-review.store.js";
import { BusinessManagerClient } from "./business-manager.client.js";
import type { BusinessManagerBooking, BusinessManagerOperation, BusinessManagerProperty } from "./business-manager-real-estate.schemas.js";

const catalogExtensionSchema = z.object({
  listingType: z.enum(["sale", "rent"]).optional(),
  suburbs: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  priceRange: z.object({ minimum: z.number().nonnegative().optional(), maximum: z.number().nonnegative().optional() }).strict().optional(),
  minimumBedrooms: z.number().int().nonnegative().max(100).optional(),
}).strict();

const bookingExtensionSchema = z.object({
  propertyAddress: z.string().trim().min(3).max(240),
  startsAtLabel: z.string().trim().min(3).max(100),
  confirmedStartsAt: z.string().datetime({ offset: true }),
  customerName: z.string().trim().min(2).max(120),
  customerEmail: z.string().email().max(254).transform((value) => value.toLowerCase()),
  customerPhone: z.string().trim().max(40).optional(),
}).strict();

const bookingCommitExtensionSchema = bookingExtensionSchema.extend({
  propertyId: z.string().uuid(),
  slotId: z.string().uuid(),
}).strict();

const resendExtensionSchema = z.object({
  bookingId: z.string().uuid(),
  customerName: z.string().trim().min(2).max(120),
  customerEmail: z.string().email().max(254).transform((value) => value.toLowerCase()),
  propertyAddress: z.string().trim().min(3).max(240),
  startsAtLabel: z.string().trim().min(3).max(100),
}).strict();

export const BUSINESS_MANAGER_REAL_ESTATE_MANIFEST: ConnectorCapabilityManifest = {
  connectorKey: "business-manager-real-estate",
  version: "1.0.0",
  operations: [
    support("knowledge.search"), support("catalog.search"), support("catalog.get"),
    support("catalog.media"), support("availability.search"), support("availability.revalidate"),
    support("booking.prepare"), mutationSupport("booking.commit"), statusSupport("booking.status"), reconciliationSupport("booking.reconcile"),
    statusSupport("delivery.status"), support("delivery.prepare-resend"), mutationSupport("delivery.commit-resend"), reconciliationSupport("delivery.reconcile"),
    statusSupport("workflow.status"),
  ],
};

@Injectable()
export class BusinessManagerRealEstateConnector {
  constructor(
    private readonly client: BusinessManagerClient,
    private readonly reviews: PostgresActionReviewStore,
  ) {}

  async search(input: { query?: string; page: { cursor?: string; limit: number }; extension?: ExtensionValue }, context: CapabilityContext) {
    const extension = catalogExtensionSchema.parse(input.extension ?? {});
    const offset = decodeCursor(input.page.cursor);
    const requested = Math.min(input.page.limit, 25);
    const response = await this.client.searchProperties({
      location: input.query,
      listingType: extension.listingType,
      suburbs: extension.suburbs,
      minPrice: extension.priceRange?.minimum,
      maxPrice: extension.priceRange?.maximum,
      minBedrooms: extension.minimumBedrooms,
      limit: requested + 1,
      offset,
    });
    const hasMore = response.properties.length > requested;
    return {
      items: response.properties.slice(0, requested).map((property) => catalogItem(property, context.connectorBindingId)),
      page: { hasMore, ...(hasMore ? { nextCursor: encodeCursor(offset + requested) } : {}) },
      sources: [source(context)],
    };
  }

  async get(input: { resource: { connectorBindingId: string; opaqueId: string } }, context: CapabilityContext) {
    assertBinding(input.resource.connectorBindingId, context);
    const response = await this.client.getProperty(z.string().uuid().parse(input.resource.opaqueId));
    return { item: catalogItem(response.property, context.connectorBindingId, true), sources: [source(context)] };
  }

  async getMedia(input: { resource: { connectorBindingId: string; opaqueId: string } }, context: CapabilityContext) {
    assertBinding(input.resource.connectorBindingId, context);
    const response = await this.client.getProperty(z.string().uuid().parse(input.resource.opaqueId));
    return {
      items: response.property.media.map((media) => ({
        mediaRef: media.url,
        mediaType: "image" as const,
        ...(media.altText ? { altText: media.altText } : {}),
        extension: { displayOrder: media.sortOrder },
      })),
      sources: [source(context)],
    };
  }

  async searchAvailability(input: { resource: { connectorBindingId: string; opaqueId: string }; from: string; to: string }, context: CapabilityContext) {
    assertBinding(input.resource.connectorBindingId, context);
    const response = await this.client.getInspectionSlots(z.string().uuid().parse(input.resource.opaqueId), { from: input.from, to: input.to });
    return {
      options: response.slots.map((slot) => ({
        optionRef: slot.slotId,
        resource: input.resource,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: slot.placesAvailable > 1 ? "available" as const : "limited" as const,
        extension: { inspectionType: "open", capacity: slot.capacity, placesAvailable: slot.placesAvailable, startsAtLabel: slot.startsAtLabel },
      })),
      sources: [source(context)],
    };
  }

  async revalidate(input: { resource: { connectorBindingId: string; opaqueId: string }; optionRef: string }, context: CapabilityContext) {
    assertBinding(input.resource.connectorBindingId, context);
    const response = await this.client.getInspectionSlot(
      z.string().uuid().parse(input.resource.opaqueId),
      z.string().uuid().parse(input.optionRef),
    );
    const slot = response.slot;
    return {
      option: {
        optionRef: slot.slotId,
        resource: input.resource,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: slot.status !== "open" || slot.placesAvailable === 0 ? "unavailable" as const : slot.placesAvailable > 1 ? "available" as const : "limited" as const,
        extension: { inspectionType: "open", capacity: slot.capacity, placesAvailable: slot.placesAvailable, startsAtLabel: slot.startsAtLabel },
      },
      revalidatedAt: new Date().toISOString(),
    };
  }

  async prepare(input: { resource: { connectorBindingId: string; opaqueId: string }; optionRef: string; extension?: ExtensionValue }, context: CapabilityContext) {
    assertBinding(input.resource.connectorBindingId, context);
    const extension = bookingExtensionSchema.parse(input.extension ?? {});
    const availability = await this.revalidate(input, context);
    if (availability.option.status === "unavailable" || availability.option.startsAt !== extension.confirmedStartsAt) {
      throw new Error("The selected inspection is no longer available or its time changed.");
    }
    const payload = bookingPayload(input.resource.opaqueId, input.optionRef, extension);
    const review = await this.reviews.create(reviewContext(context), "inspection.booking", payload);
    return {
      reviewId: review.reviewId,
      commandId: review.commandId,
      requestHash: hash(payload),
      expiresAt: review.expiresAt,
      summary: `${extension.customerName} — ${extension.propertyAddress}, ${extension.startsAtLabel} — ${extension.customerEmail}`,
    };
  }

  async commit(input: { reviewId: string; commandId: string; extension: ExtensionValue }, context: CapabilityContext): Promise<CommandReceipt> {
    const extension = bookingCommitExtensionSchema.parse(input.extension);
    const payload = bookingPayload(extension.propertyId, extension.slotId, extension);
    const commandId = await this.reviews.consume(reviewContext(context), input.reviewId, "inspection.booking", payload);
    assertCommand(input.commandId, commandId);
    const response = await this.client.bookInspection({ ...payload, confirmed: true, idempotencyKey: businessCommand(commandId) });
    return bookingReceipt(response.booking, commandId);
  }

  async getStatus(input: { operationRef: string }, _context: CapabilityContext): Promise<OperationStatus> {
    return operation((await this.client.getBookingStatus(input.operationRef)).operation);
  }

  async reconcile(input: { commandId: string }, _context: CapabilityContext): Promise<OperationStatus> {
    return operation((await this.client.reconcileBooking(businessCommand(input.commandId))).operation);
  }

  async searchKnowledge(input: { query: string; page: { cursor?: string; limit: number }; extension?: ExtensionValue }, context: CapabilityContext) {
    const offset = decodeCursor(input.page.cursor);
    if (offset !== 0) return { items: [], page: { hasMore: false }, sources: [source(context)] };
    const knowledgeExtension = z.object({ category: z.enum(["renting", "selling", "inspections", "general"]).optional() }).strict().parse(input.extension ?? {});
    const response = await this.client.searchKnowledge({ q: input.query, limit: Math.min(input.page.limit, 5), category: knowledgeExtension.category });
    return {
      items: response.results.map((record) => ({
        recordRef: { connectorBindingId: context.connectorBindingId, opaqueId: record.knowledgeId },
        title: record.question,
        excerpt: record.answer,
        sources: [source(context, `agency-knowledge:${record.knowledgeId}`)],
        extension: { category: record.category, jurisdiction: record.jurisdiction, reviewedAt: record.reviewedAt },
      })),
      page: { hasMore: false },
      sources: [source(context)],
    };
  }

  async prepareResend(input: { operationRef: string; extension?: ExtensionValue }, context: CapabilityContext) {
    const extension = resendExtensionSchema.parse({ ...input.extension, bookingId: input.operationRef });
    const payload = resendPayload(extension);
    const review = await this.reviews.create(reviewContext(context), "inspection.resend", payload);
    return { reviewId: review.reviewId, commandId: review.commandId, requestHash: hash(payload), expiresAt: review.expiresAt,
      summary: `${extension.customerName} — ${extension.propertyAddress}, ${extension.startsAtLabel} — resend to ${extension.customerEmail}` };
  }

  async commitResend(input: { reviewId: string; commandId: string; extension: ExtensionValue }, context: CapabilityContext): Promise<CommandReceipt> {
    const extension = resendExtensionSchema.parse(input.extension);
    const payload = resendPayload(extension);
    const commandId = await this.reviews.consume(reviewContext(context), input.reviewId, "inspection.resend", payload);
    assertCommand(input.commandId, commandId);
    const response = await this.client.resendInspectionConfirmation({ bookingId: extension.bookingId, customerEmail: extension.customerEmail,
      confirmed: true, idempotencyKey: businessCommand(commandId) });
    return { commandId, operationRef: extension.bookingId,
      status: response.confirmationEmail.status === "delivered" || response.confirmationEmail.status === "already_delivered" ? "succeeded" : "accepted",
      acceptedAt: new Date().toISOString(), extension: { confirmationEmail: response.confirmationEmail } };
  }

  async getDeliveryStatus(input: { operationRef: string }, _context: CapabilityContext): Promise<OperationStatus> {
    return operation((await this.client.getDeliveryStatus(input.operationRef)).operation);
  }

  async reconcileDelivery(input: { commandId: string }, _context: CapabilityContext): Promise<OperationStatus> {
    return operation((await this.client.reconcileDelivery(businessCommand(input.commandId))).operation);
  }

  async getWorkflowStatus(input: { workflowRef: string }, _context: CapabilityContext): Promise<OperationStatus> {
    return operation((await this.client.getWorkflowStatus(input.workflowRef)).operation);
  }
}

// TypeScript cannot disambiguate same-named methods from multiple ports. These aliases
// keep the connector explicit at registration time without weakening the port contracts.
export const businessManagerRealEstatePorts = (connector: BusinessManagerRealEstateConnector) => ({
  knowledge: { search: connector.searchKnowledge.bind(connector) } satisfies KnowledgePort,
  catalog: { search: connector.search.bind(connector), get: connector.get.bind(connector), getMedia: connector.getMedia.bind(connector) } satisfies CatalogPort,
  availability: { search: connector.searchAvailability.bind(connector), revalidate: connector.revalidate.bind(connector) } satisfies AvailabilityPort,
  booking: { prepare: connector.prepare.bind(connector), commit: connector.commit.bind(connector), getStatus: connector.getStatus.bind(connector), reconcile: connector.reconcile.bind(connector) } satisfies BookingPort,
  delivery: { getStatus: connector.getDeliveryStatus.bind(connector), prepareResend: connector.prepareResend.bind(connector), commitResend: connector.commitResend.bind(connector), reconcile: connector.reconcileDelivery.bind(connector) } satisfies DeliveryPort,
  workflowStatus: { getStatus: connector.getWorkflowStatus.bind(connector) } satisfies WorkflowStatusPort,
});

function catalogItem(property: BusinessManagerProperty, connectorBindingId: string, detail = false) {
  const features = property.features ?? [];
  return {
    resource: { connectorBindingId, opaqueId: property.propertyId },
    title: property.title,
    ...(property.description ? { summary: property.description } : {}),
    extension: {
      listingType: property.listingType,
      ...(property.suburb ? { suburb: property.suburb } : {}),
      ...(property.priceDisplay ? { displayPrice: property.priceDisplay } : {}),
      ...(property.bedrooms !== null && property.bedrooms !== undefined ? { bedrooms: property.bedrooms } : {}),
      ...(property.bathrooms !== null && property.bathrooms !== undefined ? { bathrooms: property.bathrooms } : {}),
      ...(property.carSpaces !== null && property.carSpaces !== undefined ? { carSpaces: property.carSpaces } : {}),
      ...(detail ? { ...(property.description ? { description: property.description } : {}), features } : {}),
    },
  };
}

function bookingPayload(propertyId: string, slotId: string, extension: z.infer<typeof bookingExtensionSchema>) {
  return { propertyId, slotId, confirmedStartsAt: extension.confirmedStartsAt, customerName: extension.customerName,
    customerEmail: extension.customerEmail, ...(extension.customerPhone ? { customerPhone: extension.customerPhone } : {}) };
}

function resendPayload(extension: z.infer<typeof resendExtensionSchema>) {
  return { bookingId: extension.bookingId, customerEmail: extension.customerEmail };
}

function bookingReceipt(booking: BusinessManagerBooking, commandId: string): CommandReceipt {
  return { commandId, operationRef: booking.bookingId, status: "succeeded", acceptedAt: new Date().toISOString(),
    extension: { bookingId: booking.bookingId, status: booking.status, reportDelivery: booking.reportDelivery, confirmationEmail: booking.confirmationEmail } };
}

function operation(value: BusinessManagerOperation): OperationStatus {
  return { operationRef: value.operationRef, status: value.status, updatedAt: value.updatedAt,
    ...(value.status === "failed" ? { retryable: false } : {}),
    ...(value.detail ? { extension: value.detail } : {}) };
}

function source(context: CapabilityContext, sourceRef = "business-manager:real-estate"): SourceMetadata {
  return { sourceRef, retrievedAt: new Date().toISOString(), freshness: "live", accessClassification: "internal" };
}

function reviewContext(context: CapabilityContext) { return { sessionId: context.sessionId, customerId: context.tenantId }; }
function assertBinding(bindingId: string, context: CapabilityContext) { if (bindingId !== context.connectorBindingId) throw new Error("Resource binding does not match the authorised connector binding."); }
function assertCommand(expected: string, actual: string) { if (expected !== actual) throw new Error("The command does not match the confirmed review."); }
function businessCommand(value: string) { return value.startsWith("sophia:") ? value : `sophia:${value}`; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function encodeCursor(offset: number) { return `offset:${offset}`; }
function decodeCursor(cursor?: string) { if (!cursor) return 0; const match = /^offset:(\d{1,5})$/.exec(cursor); if (!match) throw new Error("Invalid Business Manager catalog cursor."); return Number(match[1]); }
function support(operationId: ConnectorCapabilityManifest["operations"][number]["operationId"]): ConnectorCapabilityManifest["operations"][number] { return { operationId, enabled: true, idempotency: "not-applicable", reconciliation: "unsupported", cancellation: "unsupported", liveStatus: "none" }; }
function mutationSupport(operationId: "booking.commit" | "delivery.commit-resend"): ConnectorCapabilityManifest["operations"][number] { return { operationId, enabled: true, idempotency: "stable-command", reconciliation: "lookup", cancellation: "before-commit", liveStatus: "none" }; }
function statusSupport(operationId: "booking.status" | "delivery.status" | "workflow.status"): ConnectorCapabilityManifest["operations"][number] { return { operationId, enabled: true, idempotency: "not-applicable", reconciliation: "lookup", cancellation: "unsupported", liveStatus: "poll" }; }
function reconciliationSupport(operationId: "booking.reconcile" | "delivery.reconcile"): ConnectorCapabilityManifest["operations"][number] { return { operationId, enabled: true, idempotency: "not-applicable", reconciliation: "lookup", cancellation: "unsupported", liveStatus: "poll" }; }
