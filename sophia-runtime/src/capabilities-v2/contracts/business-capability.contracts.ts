import { z } from "zod";

const identifier = z.string().trim().min(1).max(160);
const opaqueIdentifier = z.string().trim().min(1).max(512);
const isoDateTime = z.string().datetime({ offset: true });

export const CapabilityOperationIdSchema = z.enum([
  "knowledge.search",
  "catalog.search",
  "catalog.get",
  "catalog.media",
  "availability.search",
  "availability.revalidate",
  "booking.prepare",
  "booking.commit",
  "booking.status",
  "booking.reconcile",
  "delivery.status",
  "delivery.prepare-resend",
  "delivery.commit-resend",
  "delivery.reconcile",
  "workflow.status",
  "handoff.request",
  "handoff.status",
  "ui.dismiss",
]);

export const ResourceRefSchema = z.object({
  connectorBindingId: z.string().uuid(),
  opaqueId: opaqueIdentifier.refine((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), {
    message: "Resource references must be connector-opaque identifiers, not URLs.",
  }),
}).strict();

export const SourceMetadataSchema = z.object({
  sourceRef: opaqueIdentifier,
  retrievedAt: isoDateTime,
  freshness: z.enum(["live", "cached", "stale", "unknown"]),
  accessClassification: z.enum(["public", "internal", "personal", "sensitive"]),
}).strict();

export const PageRequestSchema = z.object({
  cursor: opaqueIdentifier.optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();

export const PageInfoSchema = z.object({
  nextCursor: opaqueIdentifier.optional(),
  hasMore: z.boolean(),
}).strict();

export const CatalogItemSchema = z.object({
  resource: ResourceRefSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(2_000).optional(),
  extension: z.unknown().optional(),
}).strict();

export const MediaItemSchema = z.object({
  mediaRef: opaqueIdentifier,
  mediaType: z.enum(["image", "video", "document", "audio"]),
  altText: z.string().trim().max(500).optional(),
  extension: z.unknown().optional(),
}).strict();

export const AvailabilityOptionSchema = z.object({
  optionRef: opaqueIdentifier,
  resource: ResourceRefSchema,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  status: z.enum(["available", "limited", "unavailable", "unknown"]),
  extension: z.unknown().optional(),
}).strict().refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
  message: "Availability end must follow its start.",
  path: ["endsAt"],
});

export const PreparedCommandSchema = z.object({
  reviewId: z.string().uuid(),
  commandId: opaqueIdentifier,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: isoDateTime,
  summary: z.string().trim().min(1).max(2_000),
}).strict();

export const OperationStatusSchema = z.object({
  operationRef: opaqueIdentifier,
  status: z.enum([
    "accepted", "processing", "succeeded", "failed", "cancelled", "outcome_unknown",
  ]),
  updatedAt: isoDateTime,
  retryable: z.boolean().optional(),
  extension: z.unknown().optional(),
}).strict();

export const CapabilityContextSchema = z.object({
  tenantId: z.string().uuid(),
  sessionId: identifier,
  capabilityBindingId: z.string().uuid(),
  connectorBindingId: z.string().uuid(),
  actorRef: identifier,
  correlationId: identifier,
  deadline: isoDateTime,
}).strict();

export type CapabilityOperationId = z.infer<typeof CapabilityOperationIdSchema>;
export type ResourceRef = z.infer<typeof ResourceRefSchema>;
export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;
export type PageRequest = z.infer<typeof PageRequestSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type CatalogItem = z.infer<typeof CatalogItemSchema>;
export type MediaItem = z.infer<typeof MediaItemSchema>;
export type AvailabilityOption = z.infer<typeof AvailabilityOptionSchema>;
export type PreparedCommand = z.infer<typeof PreparedCommandSchema>;
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
export type CapabilityContext = z.infer<typeof CapabilityContextSchema> & { abortSignal?: AbortSignal };

export type ExtensionValue = Readonly<Record<string, unknown>>;

export type KnowledgeRecord = {
  recordRef: ResourceRef;
  title: string;
  excerpt: string;
  sources: SourceMetadata[];
  extension?: ExtensionValue;
};

export type CommandReceipt = {
  commandId: string;
  operationRef: string;
  status: OperationStatus["status"];
  acceptedAt: string;
  extension?: ExtensionValue;
};
