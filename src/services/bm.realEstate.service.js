import * as model from "../models/bm.realEstate.model.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
    city: city(input.city) || undefined,
    suburb: text(input.suburb) || undefined,
    minBedrooms: integer(input.minBedrooms, 0, 20),
    maxPrice: integer(input.maxPrice, 1, 100_000_000),
    limit: integer(input.limit, 1, 3) ?? 3,
  });
}

export const getProperty = (companyId, propertyId) => model.getProperty(companyId, uuid(propertyId, "propertyId"));

export function listInspectionSlots(companyId, propertyId, input = {}) {
  const now = new Date();
  const from = input.from ? new Date(input.from) : now;
  const to = input.to ? new Date(input.to) : new Date(now.getTime() + 14 * 86400000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw httpError("Invalid inspection date range");
  return model.listInspectionSlots(companyId, uuid(propertyId, "propertyId"), from.toISOString(), to.toISOString());
}

export async function createInspectionBooking(companyId, input = {}) {
  const customerName = text(input.customerName);
  const customerEmail = text(input.customerEmail).toLowerCase();
  if (customerName.length < 2) throw httpError("customerName is required");
  if (!emailRe.test(customerEmail)) throw httpError("customerEmail must be valid");
  let result;
  try {
    result = await model.createInspectionBooking(companyId, {
      propertyId: uuid(input.propertyId, "propertyId"), slotId: uuid(input.slotId, "slotId"),
      customerName, customerEmail, customerPhone: text(input.customerPhone) || undefined,
      idempotencyKey: text(input.idempotencyKey) || `${input.slotId}:${customerEmail}`,
    });
  } catch (error) {
    if (error?.code === "23505") {
      throw httpError("This customer is already booked for the selected inspection", 409);
    }
    throw error;
  }
  if (result.errorCode) throw httpError(result.errorCode === "SLOT_FULL" ? "The inspection is fully booked" : "Inspection slot not found", 409);
  return result;
}

export function searchKnowledge(companyId, input = {}) {
  const query = text(input.q);
  if (query.length < 2) throw httpError("q must contain at least 2 characters");
  return model.searchKnowledge(companyId, query, text(input.category) || undefined, integer(input.limit, 1, 5) ?? 3);
}
