import { createHash } from "node:crypto";
import * as model from "../models/bm.realEstate.model.js";
import { sendInspectionConfirmationEmail } from "./bm.inspectionEmail.service.js";
import { PROPERTY_REPORT_VERSION } from "./townplannerReportVersions.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const inspectionTimeZone = process.env.BM_REAL_ESTATE_TIME_ZONE || "Australia/Brisbane";
const text = (value) => String(value ?? "").trim();
const city = (value) => text(value).replace(/,?\s+(city|qld|queensland)$/i, "").trim();
const integer = (value, min, max) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw httpError("Invalid numeric filter");
  return parsed;
};
function httpError(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function uuid(value, name) { const normalized = text(value); if (!UUID_RE.test(normalized)) throw httpError(`${name} must be a UUID`); return normalized; }

export function searchProperties(companyId, input = {}) {
  const listingType = text(input.listingType).toLowerCase() || undefined;
  if (listingType && !["sale", "rent"].includes(listingType)) throw httpError("listingType must be sale or rent");
  return model.searchProperties(companyId, {
    listingType, propertyType: text(input.propertyType) || undefined,
    location: city(input.location) || undefined,
    city: city(input.city) || undefined,
    suburb: text(input.suburb) || undefined,
    suburbs: commaList(input.suburbs, 20),
    minPrice: integer(input.minPrice, 0, 100_000_000),
    minBedrooms: integer(input.minBedrooms, 0, 20),
    maxPrice: integer(input.maxPrice, 1, 100_000_000),
    limit: integer(input.limit, 1, 26) ?? 3,
    offset: integer(input.offset, 0, 10_000) ?? 0,
  });
}

export const getProperty = (companyId, propertyId) => model.getProperty(companyId, uuid(propertyId, "propertyId"));

export async function listInspectionSlots(companyId, propertyId, input = {}) {
  const now = new Date();
  const from = input.from ? new Date(input.from) : now;
  const to = input.to ? new Date(input.to) : new Date(now.getTime() + 14 * 86400000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw httpError("Invalid inspection date range");
  const slots = await model.listInspectionSlots(companyId, uuid(propertyId, "propertyId"), from.toISOString(), to.toISOString());
  return slots.map(withInspectionTimeLabels);
}

export async function getInspectionSlot(companyId, propertyId, slotId) {
  const slot = await model.getInspectionSlot(
    companyId,
    uuid(propertyId, "propertyId"),
    uuid(slotId, "slotId"),
  );
  if (!slot) throw httpError("Inspection slot not found", 404);
  return withInspectionTimeLabels(slot);
}

export async function createInspectionBooking(companyId, input = {}) {
  const customerName = text(input.customerName);
  const customerEmail = text(input.customerEmail).toLowerCase();
  const confirmedStartsAt = new Date(input.confirmedStartsAt);
  if (customerName.length < 2) throw httpError("customerName is required");
  if (!emailRe.test(customerEmail)) throw httpError("customerEmail must be valid");
  if (!Number.isFinite(confirmedStartsAt.getTime())) throw httpError("confirmedStartsAt must be a valid inspection time");
  let result;
  try {
    result = await model.createInspectionBooking(companyId, {
      propertyId: uuid(input.propertyId, "propertyId"), slotId: uuid(input.slotId, "slotId"),
      customerName, customerEmail, customerPhone: text(input.customerPhone) || undefined,
      confirmedStartsAt: confirmedStartsAt.toISOString(),
      idempotencyKey: text(input.idempotencyKey) || `${input.slotId}:${customerEmail}`,
    }, { reportVersion: PROPERTY_REPORT_VERSION,
      workflowVersionId: input.workflowVersionId ? uuid(input.workflowVersionId, "workflowVersionId") : undefined });
  } catch (error) {
    if (error?.code === "23505") {
      throw httpError("This customer is already booked for the selected inspection", 409);
    }
    throw error;
  }
  if (result.errorCode) {
    const message = result.errorCode === "SLOT_FULL"
      ? "The inspection is fully booked"
      : result.errorCode === "SLOT_TIME_MISMATCH"
        ? "The confirmed inspection time does not match the selected slot"
        : "Inspection slot not found";
    throw httpError(message, 409);
  }
  return withInspectionTimeLabels(result);
}

export async function getInspectionBookingStatus(companyId, bookingId) {
  const normalizedBookingId = uuid(bookingId, "bookingId");
  const booking = await model.getInspectionBooking(companyId, normalizedBookingId);
  if (!booking) throw httpError("Inspection booking not found", 404);
  return operationStatus(normalizedBookingId, bookingStatus(booking.status), booking.createdAt, {
    bookingId: booking.bookingId,
    propertyId: booking.propertyId,
    slotId: booking.slotId,
  });
}

export async function reconcileInspectionBooking(companyId, commandId) {
  const normalizedCommandId = boundedCommandId(commandId);
  const booking = await model.findInspectionBookingByCommand(companyId, normalizedCommandId);
  if (!booking) return operationStatus(normalizedCommandId, "outcome_unknown", new Date(), { commandId: normalizedCommandId });
  return operationStatus(booking.bookingId, bookingStatus(booking.status), booking.createdAt, {
    commandId: normalizedCommandId,
    bookingId: booking.bookingId,
  });
}

export async function getInspectionDeliveryStatus(companyId, operationRef) {
  const normalizedRef = uuid(operationRef, "operationRef");
  const delivery = await model.getInspectionDeliveryStatus(companyId, normalizedRef);
  if (!delivery) throw httpError("Inspection delivery not found", 404);
  return operationStatus(delivery.deliveryId, deliveryStatus(delivery.status), delivery.updatedAt, {
    bookingId: delivery.bookingId,
    reportJobId: delivery.reportJobId,
    reportStatus: delivery.reportStatus,
    deliveryStatus: delivery.status,
    attemptCount: delivery.attemptCount,
    providerKey: delivery.providerKey,
    providerMessageId: delivery.providerMessageId,
    providerAcceptedAt: delivery.providerAcceptedAt,
    verifiedDeliveredAt: delivery.verifiedDeliveredAt,
  });
}

export async function reconcileInspectionDelivery(companyId, commandId) {
  const normalizedCommandId = boundedCommandId(commandId);
  const command = await model.getInspectionEmailCommand(companyId, normalizedCommandId);
  if (!command) return operationStatus(normalizedCommandId, "outcome_unknown", new Date(), { commandId: normalizedCommandId });
  const completed = command.status === "completed" ? commandDeliveryStatus(command.response?.status) : null;
  const statuses = { executing: "processing", failed: "failed", unknown: "outcome_unknown" };
  return operationStatus(command.bookingId, completed || statuses[command.status] || "outcome_unknown", command.updatedAt, {
    commandId: command.commandId,
    bookingId: command.bookingId,
    commandStatus: command.status,
    deliveryStatus: command.response?.status,
    attemptCount: command.attemptCount,
  });
}

export async function getPropertyWorkflowStatus(companyId, workflowRef) {
  const normalizedRef = uuid(workflowRef, "workflowRef");
  const workflow = await model.getPropertyWorkflowStatus(companyId, normalizedRef);
  if (!workflow) throw httpError("Property workflow not found", 404);
  const reportStatuses = { queued: "accepted", retry: "processing", daily_retry: "processing", running: "processing", ready: "succeeded", failed: "failed" };
  const reportStatus = workflow.reportStatus || workflow.status;
  const status = workflow.deliveryStatus
    ? deliveryStatus(workflow.deliveryStatus)
    : reportStatuses[reportStatus] || "outcome_unknown";
  return operationStatus(normalizedRef, status, workflow.updatedAt, {
    workflowRef: workflow.workflowRef,
    reportJobId: workflow.reportJobId || workflow.workflowRef,
    reportStatus,
    reportAttemptCount: workflow.reportAttemptCount ?? workflow.attemptCount,
    deliveryStatus: workflow.deliveryStatus,
    deliveryAttemptCount: workflow.deliveryAttemptCount,
    workflowVersionId: workflow.workflowVersionId,
    completedAt: workflow.completedAt,
  });
}

export async function sendInspectionConfirmation(companyId, bookingId, input = {}) {
  const normalizedBookingId = uuid(bookingId, "bookingId");
  const booking = await model.getInspectionBooking(companyId, normalizedBookingId);
  if (!booking) throw httpError("Inspection booking not found", 404);

  if (input.confirmed !== true) {
    throw httpError("Customer confirmation is required before sending email");
  }
  const customerEmail = text(input.customerEmail || booking.customerEmail).toLowerCase();
  if (!emailRe.test(customerEmail)) throw httpError("customerEmail must be valid");
  const forceResend = input.forceResend === true;
  const commandId = text(input.idempotencyKey);
  let command = null;
  let providerSubmissionStarted = false;
  if (commandId) {
    command = await model.beginInspectionEmailCommand(
      companyId,
      normalizedBookingId,
      customerEmail,
      commandId,
    );
    if (!command.created && command.status === "completed") return command.response;
    if (!command.created && ["executing", "unknown"].includes(command.status)) {
      throw httpError("The previous delivery result is still being reconciled", 409);
    }
    if (!command.created && command.status === "failed") {
      const retrying = await model.retryInspectionEmailCommand(commandId);
      if (!retrying) throw httpError("The delivery command could not be retried", 409);
    }
  }

  try {
    if (booking.listingType === "sale") {
      const queued = await model.queueSaleInspectionConfirmation(
        companyId,
        normalizedBookingId,
        customerEmail,
        forceResend,
      );
      const readyForEmail = queued.deliveryStatus === "email_queued";
      const response = {
        status: readyForEmail ? "queued" : "pending_report",
        customerEmail,
        resent: forceResend,
        reportStatus: queued.reportStatus,
        message: readyForEmail
          ? "The confirmation email and property report are queued for delivery."
          : "The confirmation email will be sent when the property report is ready.",
      };
      if (commandId) await model.completeInspectionEmailCommand(commandId, response);
      return response;
    }

    if ((booking.confirmationEmailVerifiedDeliveredAt || booking.confirmationEmailAcceptedAt || booking.confirmationEmailSentAt) && !forceResend) {
      const response = {
        status: booking.confirmationEmailVerifiedDeliveredAt ? "delivered" : "provider_accepted",
        acceptedAt: booking.confirmationEmailAcceptedAt || booking.confirmationEmailSentAt,
        customerEmail: booking.customerEmail,
      };
      if (commandId) await model.completeInspectionEmailCommand(commandId, response);
      return response;
    }

    const labelledBooking = withInspectionTimeLabels({ ...booking, customerEmail });
    providerSubmissionStarted = true;
    const providerResult = await sendInspectionConfirmationEmail(labelledBooking);
    if (!providerResult || !["accepted", "preview"].includes(providerResult.state)) {
      throw new Error("Email provider did not return a bounded acceptance result");
    }
    await model.recordInspectionConfirmationProviderResult(
      companyId, normalizedBookingId, customerEmail, providerResult,
    );
    const response = {
      status: providerResult.state === "preview" ? "previewed" : "provider_accepted",
      customerEmail, resent: forceResend,
      ...(providerResult.providerMessageId ? { providerMessageId: providerResult.providerMessageId } : {}),
      message: providerResult.state === "preview"
        ? "The confirmation was generated in log preview mode; no recipient delivery occurred."
        : "The email provider accepted the confirmation; recipient delivery is not yet verified.",
    };
    if (commandId) await model.completeInspectionEmailCommand(commandId, response);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email delivery failed";
    if (commandId) {
      await model.failInspectionEmailCommand(
        commandId,
        message,
        providerSubmissionStarted,
      );
    }
    if (booking.listingType !== "sale") {
      await model.markInspectionConfirmationFailed(
        companyId,
        normalizedBookingId,
        message.slice(0, 500),
      );
    }
    throw error;
  }
}

function withInspectionTimeLabels(value) {
  const startsAt = new Date(value.startsAt);
  const dateLabel = new Intl.DateTimeFormat("en-AU", {
    timeZone: inspectionTimeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(startsAt);
  const timeLabel = new Intl.DateTimeFormat("en-AU", {
    timeZone: inspectionTimeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(startsAt);
  return {
    ...value,
    startsAtDateLabel: dateLabel,
    startsAtTimeLabel: timeLabel,
    startsAtLabel: `${dateLabel}, ${timeLabel}`,
    timeZone: inspectionTimeZone,
  };
}

export async function searchKnowledge(companyId, input = {}) {
  const query = text(input.q);
  if (query.length < 2) throw httpError("q must contain at least 2 characters");
  const requestedCategory = knowledgeCategory(input.category);
  const inferredCategory = inferKnowledgeCategory(query);
  const category = requestedCategory === "general"
    ? inferredCategory || requestedCategory
    : requestedCategory || inferredCategory;
  const limit = integer(input.limit, 1, 5) ?? 3;
  const matches = await model.searchKnowledge(companyId, query, category, limit);
  if (matches.length || !category || category === "general") return matches;
  return model.searchKnowledge(companyId, "", category, limit);
}

export async function getInspectionPrivacyData(companyId, input = {}) {
  const commandIds = privacyCommandIds(input.commandIds);
  const bookings = await model.getInspectionPrivacyDataByCommands(companyId, commandIds);
  const document = { schemaVersion: 1, bookings };
  return { document, digestAlgorithm: "sha256", digest: digest(document) };
}

export async function redactInspectionPrivacyData(companyId, input = {}) {
  const commandIds = privacyCommandIds(input.commandIds);
  const counts = await model.redactInspectionPrivacyDataByCommands(companyId, commandIds);
  return { status: "completed", counts, digestAlgorithm: "sha256", digest: digest(counts) };
}

function inferKnowledgeCategory(value) {
  const query = text(value).toLowerCase();
  if (/\b(rent|rental|renting|tenant|tenancy|lease|application|bond)\b/.test(query)) return "renting";
  if (/\b(sale|sell|selling|seller|vendor|appraisal|market)\b/.test(query)) return "selling";
  if (/\b(inspection|inspect|viewing|booking)\b/.test(query)) return "inspections";
  return undefined;
}

function knowledgeCategory(value) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return undefined;
  if (["rent", "rental", "renting", "tenant", "tenancy", "application"].includes(normalized)) return "renting";
  if (["sale", "sell", "selling", "seller", "vendor"].includes(normalized)) return "selling";
  if (["inspection", "inspections", "viewing", "booking"].includes(normalized)) return "inspections";
  return normalized;
}

function commaList(value, maximum) {
  if (value === undefined || value === null || value === "") return undefined;
  const values = String(value).split(",").map((item) => text(item)).filter(Boolean);
  if (!values.length || values.length > maximum || values.some((item) => item.length > 120)) {
    throw httpError("Invalid list filter");
  }
  return [...new Set(values)];
}

function privacyCommandIds(value) {
  if (!Array.isArray(value) || value.length > 100) throw httpError("commandIds must be an array of at most 100 values");
  const values = [...new Set(value.map(boundedCommandId))];
  return values;
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function boundedCommandId(value) {
  const normalized = text(value);
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw httpError("commandId is invalid");
  }
  return normalized;
}

function deliveryStatus(status) {
  if (["delivered", "fallback_delivered"].includes(status)) return "succeeded";
  if (status === "failed") return "failed";
  if (["waiting_report", "email_queued", "fallback_queued"].includes(status)) return "accepted";
  if (["email_sending", "email_retry", "provider_accepted", "fallback_provider_accepted",
    "previewed", "fallback_previewed", "sent", "fallback_sent"].includes(status)) return "processing";
  return "outcome_unknown";
}

function commandDeliveryStatus(status) {
  if (["delivered", "already_delivered"].includes(status)) return "succeeded";
  if (["queued", "pending_report"].includes(status)) return "accepted";
  if (["provider_accepted", "previewed", "sent", "already_sent"].includes(status)) return "processing";
  if (status === "failed") return "failed";
  return "outcome_unknown";
}

function bookingStatus(status) {
  if (status === "confirmed") return "succeeded";
  if (status === "cancelled") return "cancelled";
  return "outcome_unknown";
}

function operationStatus(operationRef, status, updatedAt, detail) {
  const timestamp = new Date(updatedAt);
  return {
    operationRef,
    status,
    updatedAt: Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date().toISOString(),
    detail,
  };
}
