import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import {
  BookingResponseSchema,
  ConfirmationResponseSchema,
  KnowledgeResponseSchema,
  OperationResponseSchema,
  PropertyResponseSchema,
  PropertySearchResponseSchema,
  SlotResponseSchema,
  SingleSlotResponseSchema,
  type BusinessManagerOperation,
  type BusinessManagerBooking,
} from "./business-manager-real-estate.schemas.js";
import { runtimeConfig } from "../../config/runtime-config.js";
import { z as zod } from "zod";

const ConnectorIdentitySchema = zod.object({ externalAccountId: zod.string().uuid() }).strict();
const PrivacyAccessSchema = zod.object({
  document: zod.object({ schemaVersion: zod.literal(1), bookings: zod.array(zod.record(zod.string(), zod.unknown())).max(100) }).strict(),
  digestAlgorithm: zod.literal("sha256"),
  digest: zod.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const PrivacyRedactionSchema = zod.object({
  status: zod.literal("completed"),
  counts: zod.object({
    bookingsRedacted: zod.number().int().nonnegative(),
    emailCommandsRedacted: zod.number().int().nonnegative(),
    deliveriesRedacted: zod.number().int().nonnegative(),
  }).strict(),
  digestAlgorithm: zod.literal("sha256"),
  digest: zod.string().regex(/^[a-f0-9]{64}$/),
}).strict();

@Injectable()
export class BusinessManagerClient {
  async verifyConnectorIdentity(expectedExternalAccountId: string): Promise<{ externalAccountId: string }> {
    const identity = await this.get("/bm/real-estate/connector-identity", {}, ConnectorIdentitySchema);
    if (identity.externalAccountId !== expectedExternalAccountId) {
      throw new Error("Business Manager account identity does not match the requested connector account.");
    }
    return identity;
  }
  searchProperties(input: Record<string, unknown>) {
    return this.get("/bm/real-estate/properties", input, PropertySearchResponseSchema);
  }
  getProperty(propertyId: string) {
    return this.get(`/bm/real-estate/properties/${encodeURIComponent(propertyId)}`, {}, PropertyResponseSchema);
  }
  getInspectionSlots(propertyId: string, input: Record<string, unknown>) {
    return this.get(`/bm/real-estate/properties/${encodeURIComponent(propertyId)}/inspection-slots`, input, SlotResponseSchema);
  }
  getInspectionSlot(propertyId: string, slotId: string) {
    return this.get(`/bm/real-estate/properties/${encodeURIComponent(propertyId)}/inspection-slots/${encodeURIComponent(slotId)}`, {}, SingleSlotResponseSchema);
  }
  searchKnowledge(input: Record<string, unknown>) {
    return this.get("/bm/real-estate/knowledge", input, KnowledgeResponseSchema);
  }
  async bookInspection(input: Record<string, unknown>): Promise<{ booking: BusinessManagerBooking }> {
    const created = await this.request("/bm/real-estate/inspection-bookings", {
      method: "POST",
      body: JSON.stringify({ booking: input }),
    }, BookingResponseSchema);
    const payload = created;
    const booking = created.booking;
    const bookingId = booking.bookingId;

    if (booking.listingType === "sale") {
      const reportDelivery = booking.reportDelivery;
      const emailQueued = reportDelivery?.deliveryStatus === "email_queued";
      return {
        ...payload,
        booking: {
          ...booking,
          confirmationEmail: {
            status: emailQueued ? "queued" : "pending_report",
            customerEmail: booking.customerEmail,
            reportStatus: reportDelivery?.reportStatus || "queued",
            message: emailQueued
              ? "The confirmation email and property report are queued for delivery."
              : "The property report is being prepared and will be included with the confirmation email.",
          },
        },
      };
    }

    try {
      const emailResult = await this.request(
        `/bm/real-estate/inspection-bookings/${encodeURIComponent(bookingId)}/email-confirmation`,
        {
          method: "POST",
          body: JSON.stringify({
            customerEmail: booking.customerEmail,
            confirmed: true,
          }),
        }, ConfirmationResponseSchema,
      );
      return {
        ...payload,
        booking: {
          ...booking,
          confirmationEmail: emailResult.confirmationEmail,
        },
      };
    } catch (error) {
      return {
        ...payload,
        booking: {
          ...booking,
          confirmationEmail: {
            status: "failed",
            message: error instanceof Error ? error.message : "Email delivery failed",
          },
        },
      };
    }
  }

  resendInspectionConfirmation(input: Record<string, unknown>) {
    const bookingId = String(input["bookingId"] || "");
    return this.request(
      `/bm/real-estate/inspection-bookings/${encodeURIComponent(bookingId)}/email-confirmation`,
      {
        method: "POST",
          body: JSON.stringify({
            customerEmail: input["customerEmail"],
            confirmed: input["confirmed"],
            forceResend: true,
            idempotencyKey: input["idempotencyKey"],
        }),
      }, ConfirmationResponseSchema,
    );
  }

  getBookingStatus(operationRef: string): Promise<{ operation: BusinessManagerOperation }> {
    return this.get(`/bm/real-estate/inspection-bookings/${encodeURIComponent(operationRef)}/status`, {}, OperationResponseSchema);
  }

  reconcileBooking(commandId: string): Promise<{ operation: BusinessManagerOperation }> {
    return this.get(`/bm/real-estate/inspection-booking-commands/${encodeURIComponent(commandId)}/status`, {}, OperationResponseSchema);
  }

  getDeliveryStatus(operationRef: string): Promise<{ operation: BusinessManagerOperation }> {
    return this.get(`/bm/real-estate/inspection-deliveries/${encodeURIComponent(operationRef)}/status`, {}, OperationResponseSchema);
  }

  reconcileDelivery(commandId: string): Promise<{ operation: BusinessManagerOperation }> {
    return this.get(`/bm/real-estate/inspection-delivery-commands/${encodeURIComponent(commandId)}/status`, {}, OperationResponseSchema);
  }

  getWorkflowStatus(workflowRef: string): Promise<{ operation: BusinessManagerOperation }> {
    return this.get(`/bm/real-estate/property-workflows/${encodeURIComponent(workflowRef)}/status`, {}, OperationResponseSchema);
  }

  getPrivacySubjectData(commandIds: string[]) {
    return this.request("/bm/real-estate/privacy/subject-data/access", {
      method: "POST", body: JSON.stringify({ commandIds }),
    }, PrivacyAccessSchema);
  }

  redactPrivacySubjectData(commandIds: string[]) {
    return this.request("/bm/real-estate/privacy/subject-data/redact", {
      method: "POST", body: JSON.stringify({ commandIds }),
    }, PrivacyRedactionSchema);
  }

  private get<T extends z.ZodTypeAny>(path: string, query: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const suffix = params.size ? `?${params}` : "";
    return this.request(`${path}${suffix}`, {}, schema);
  }

  private async request<T extends z.ZodTypeAny>(path: string, init: RequestInit, schema: T): Promise<z.infer<T>> {
    const config = runtimeConfig().businessManager;
    if (!config.apiToken) throw new Error("Business Manager integration is not configured.");
    const response = await fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(payload.error || `Business Manager request failed (${response.status}).`);
    return schema.parse(payload);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}
