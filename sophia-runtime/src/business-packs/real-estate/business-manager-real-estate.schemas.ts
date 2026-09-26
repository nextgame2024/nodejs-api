import { z } from "zod";

const uuid = z.string().uuid();
const nullableText = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

export const BusinessManagerMediaSchema = z.object({
  mediaId: uuid,
  url: z.string().url(),
  altText: nullableText,
  sortOrder: z.number().int().optional(),
}).strict();

export const BusinessManagerPropertySchema = z.object({
  propertyId: uuid,
  companyId: uuid.optional(),
  listingType: z.enum(["sale", "rent"]),
  propertyType: nullableText,
  status: z.string().optional(),
  title: z.string().min(1),
  address: nullableText,
  suburb: nullableText,
  city: nullableText,
  state: nullableText,
  postcode: nullableText,
  latitude: nullableNumber,
  longitude: nullableNumber,
  priceDisplay: nullableText,
  priceAmount: nullableNumber,
  bedrooms: z.number().int().nonnegative().nullable().optional(),
  bathrooms: z.number().int().nonnegative().nullable().optional(),
  carSpaces: z.number().int().nonnegative().nullable().optional(),
  description: nullableText,
  features: z.array(z.string()).nullable().optional(),
  agentName: nullableText,
  agentEmail: nullableText,
  agentPhone: nullableText,
  media: z.array(BusinessManagerMediaSchema).default([]),
}).strict();

export const BusinessManagerSlotSchema = z.object({
  slotId: uuid,
  propertyId: uuid,
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  capacity: z.number().int().positive(),
  placesAvailable: z.number().int().nonnegative(),
  startsAtDateLabel: z.string().optional(),
  startsAtTimeLabel: z.string().optional(),
  startsAtLabel: z.string().optional(),
  timeZone: z.string().optional(),
}).strict();

const reportDeliverySchema = z.object({
  reportJobId: uuid,
  reportStatus: z.enum(["queued", "retry", "daily_retry", "running", "ready", "failed"]),
  deliveryId: uuid,
  deliveryStatus: z.enum([
    "waiting_report", "email_queued", "email_sending", "email_retry",
    "provider_accepted", "fallback_provider_accepted", "previewed", "fallback_previewed",
    "outcome_unknown", "delivered", "fallback_delivered", "sent", "fallback_sent", "failed",
  ]),
  workflowVersionId: uuid.optional(),
}).strict();

const confirmationEmailSchema = z.object({
  status: z.enum([
    "queued", "pending_report", "provider_accepted", "previewed", "delivered",
    "already_delivered", "sent", "already_sent", "failed",
  ]),
  sentAt: z.string().optional(),
  acceptedAt: z.string().or(z.date()).optional(),
  customerEmail: z.string().email().optional(),
  reportStatus: z.string().optional(),
  resent: z.boolean().optional(),
  providerMessageId: z.string().max(512).optional(),
  message: z.string().optional(),
}).strict();

export const BusinessManagerBookingSchema = z.object({
  bookingId: uuid,
  companyId: uuid.optional(),
  propertyId: uuid.optional(),
  slotId: uuid.optional(),
  customerName: z.string().optional(),
  customerEmail: z.string().email().optional(),
  customerPhone: nullableText,
  status: z.string().optional(),
  createdAt: z.string().or(z.date()).optional(),
  confirmationEmailSentAt: z.string().or(z.date()).nullable().optional(),
  confirmationEmailProviderKey: nullableText,
  confirmationEmailProviderMessageId: nullableText,
  confirmationEmailAcceptedAt: z.string().or(z.date()).nullable().optional(),
  confirmationEmailPreviewedAt: z.string().or(z.date()).nullable().optional(),
  confirmationEmailVerifiedDeliveredAt: z.string().or(z.date()).nullable().optional(),
  confirmationEmailError: nullableText,
  startsAt: z.string().or(z.date()).optional(),
  endsAt: z.string().or(z.date()).optional(),
  startsAtDateLabel: z.string().optional(),
  startsAtTimeLabel: z.string().optional(),
  startsAtLabel: z.string().optional(),
  timeZone: z.string().optional(),
  listingType: z.enum(["sale", "rent"]).optional(),
  propertyAddress: nullableText,
  propertySuburb: nullableText,
  propertyCity: nullableText,
  propertyState: nullableText,
  propertyPostcode: nullableText,
  propertyLatitude: nullableNumber,
  propertyLongitude: nullableNumber,
  propertyUpdatedAt: z.string().or(z.date()).optional(),
  reportDelivery: reportDeliverySchema.optional(),
  confirmationEmail: confirmationEmailSchema.optional(),
}).strict();

export const BusinessManagerKnowledgeSchema = z.object({
  knowledgeId: uuid,
  category: z.string(),
  question: z.string(),
  answer: z.string(),
  sourceUrl: z.string().url().nullable().optional(),
  jurisdiction: nullableText,
  reviewedAt: z.string().or(z.date()).nullable().optional(),
}).strict();

export const BusinessManagerOperationSchema = z.object({
  operationRef: z.string().min(1).max(512),
  status: z.enum(["accepted", "processing", "succeeded", "failed", "cancelled", "outcome_unknown"]),
  updatedAt: z.string().datetime({ offset: true }),
  detail: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const PropertySearchResponseSchema = z.object({ properties: z.array(BusinessManagerPropertySchema) }).strict();
export const PropertyResponseSchema = z.object({ property: BusinessManagerPropertySchema }).strict();
export const SlotResponseSchema = z.object({ slots: z.array(BusinessManagerSlotSchema) }).strict();
export const SingleSlotResponseSchema = z.object({ slot: BusinessManagerSlotSchema.extend({ status: z.string().optional() }).strict() }).strict();
export const KnowledgeResponseSchema = z.object({ results: z.array(BusinessManagerKnowledgeSchema) }).strict();
export const BookingResponseSchema = z.object({ booking: BusinessManagerBookingSchema }).strict();
export const ConfirmationResponseSchema = z.object({ confirmationEmail: confirmationEmailSchema }).strict();
export const OperationResponseSchema = z.object({ operation: BusinessManagerOperationSchema }).strict();

export type BusinessManagerProperty = z.infer<typeof BusinessManagerPropertySchema>;
export type BusinessManagerBooking = z.infer<typeof BusinessManagerBookingSchema>;
export type BusinessManagerOperation = z.infer<typeof BusinessManagerOperationSchema>;
