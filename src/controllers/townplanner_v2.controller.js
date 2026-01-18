import crypto from "crypto";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import {
  createReportRequestV2,
  getReportRequestByTokenV2,
  markReportRequestStatusV2,
} from "../models/townplanner_v2.model.js";
import { sendReportLinkEmailV2 } from "../services/reportEmail_v2.service.js";
import {
  autocompleteAddresses,
  getPlaceDetails,
} from "../services/googlePlaces_v2.service.js";
import { fetchPlanningDataV2 } from "../services/planningData_v2.service.js";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

export const createReportRequestV2Controller = asyncHandler(
  async (req, res) => {
    const { email, addressLabel, placeId = null, lat, lng } = req.body || {};

    if (!isValidEmail(email)) {
      res.status(400);
      throw new Error("Invalid email");
    }
    if (!addressLabel || typeof addressLabel !== "string") {
      res.status(400);
      throw new Error("Missing addressLabel");
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(400);
      throw new Error("lat/lng must be numbers");
    }

    const token = crypto.randomUUID();

    const row = await createReportRequestV2({
      token,
      email: email.trim().toLowerCase(),
      addressLabel: addressLabel.trim(),
      placeId,
      lat,
      lng,
      planningSnapshot: null, // Phase 2 can populate this
    });

    const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || "").replace(
      /\/$/,
      ""
    );
    if (!frontendBaseUrl) {
      res.status(500);
      throw new Error("Missing FRONTEND_BASE_URL env var");
    }

    // Example: https://propertease.com.au/townplanner/report/<token>
    const viewUrl = `${frontendBaseUrl}/townplanner/report/${row.token}`;

    // mark sending
    await markReportRequestStatusV2({ token: row.token, status: "sending" });

    await sendReportLinkEmailV2({
      toEmail: row.email,
      addressLabel: row.address_label,
      viewUrl,
    });

    await markReportRequestStatusV2({ token: row.token, status: "sent" });

    res.json({
      ok: true,
      token: row.token,
    });
  }
);

export const getReportByTokenV2Controller = asyncHandler(async (req, res) => {
  const { token } = req.params;

  const row = await getReportRequestByTokenV2(token);
  if (!row) {
    res.status(404);
    throw new Error("Report not found");
  }

  const now = new Date();
  if (row.expires_at && new Date(row.expires_at) < now) {
    res.status(410);
    throw new Error("Report link expired");
  }

  res.json({
    ok: true,
    report: {
      token: row.token,
      addressLabel: row.address_label,
      placeId: row.place_id,
      lat: row.lat,
      lng: row.lng,
      planningSnapshot: row.planning_snapshot, // null in Phase 1
      status: row.status,
      createdAt: row.created_at,
    },
  });
});

export const suggestAddresses_v2 = asyncHandler(async (req, res) => {
  const input = (req.query.input ?? req.query.q ?? "").toString();
  const sessionToken = (req.query.sessionToken || "").toString().trim() || null;

  const trimmed = input.trim();
  if (trimmed.length < 3) return res.json({ suggestions: [] });
  if (trimmed.length > 120) {
    res.status(400);
    throw new Error("Input too long");
  }

  const suggestions = await autocompleteAddresses({
    input: trimmed,
    sessionToken,
  });
  res.json({ suggestions });
});

export const placeDetails_v2 = asyncHandler(async (req, res) => {
  const placeId = (req.query.placeId || "").toString().trim();
  const sessionToken = (req.query.sessionToken || "").toString().trim() || null;

  if (!placeId) {
    res.status(400);
    throw new Error("Missing placeId");
  }

  const details = await getPlaceDetails({ placeId, sessionToken });

  // Enrich with planning geometries + conventions (V1 parity) when we have lat/lng.
  // This keeps the V2 frontend flow unchanged: select address -> call /place-details.
  let planning = null;
  try {
    if (typeof details?.lat === "number" && typeof details?.lng === "number") {
      planning = await fetchPlanningDataV2({
        lat: details.lat,
        lng: details.lng,
      });
    }
  } catch (e) {
    // Non-fatal: return place details even if planning lookup fails.
    console.error(
      "[townplanner_v2] planning enrichment failed:",
      e?.message || e
    );
  }

  res.json({
    ...details,
    planning, // null if DB not configured or lookup fails
  });
});
