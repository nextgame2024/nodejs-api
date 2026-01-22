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
import {
  findReadyReportByHashV2,
  markReportRunningV2,
  markReportReadyV2,
  markReportFailedV2,
} from "../models/townplanner_v2.model.js";

import {
  generateTownPlannerReportV2,
  computeInputsHashV2,
} from "../services/townplanner_report_v2.service.js";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

const inFlight = new Set();

export const generateReportV2Controller = asyncHandler(async (req, res) => {
  const {
    token: tokenFromBody,
    addressLabel,
    placeId = null,
    lat,
    lng,
    force = false,
  } = req.body || {};

  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400);
    throw new Error("lat/lng must be numbers");
  }
  if (!addressLabel || typeof addressLabel !== "string") {
    res.status(400);
    throw new Error("Missing addressLabel");
  }

  // Stable cache key
  const inputsHash = computeInputsHashV2({
    addressLabel: addressLabel.trim(),
    placeId: placeId || null,
    lat,
    lng,
    schemeVersion: process.env.CITY_PLAN_SCHEME_VERSION || "City Plan 2014",
  });

  if (!force) {
    const cached = await findReadyReportByHashV2(inputsHash);
    if (cached?.pdf_url) {
      return res.json({
        ok: true,
        token: cached.token,
        status: "ready",
        pdfUrl: cached.pdf_url,
        cached: true,
      });
    }
  }

  // Create a token if caller didn’t supply one (app flow)
  const token = tokenFromBody || crypto.randomUUID();

  // If this token already exists, we will just generate against it.
  // If it does not exist, create a minimal record (email not required for app flow).
  let row = await getReportRequestByTokenV2(token);
  if (!row) {
    row = await createReportRequestV2({
      token,
      email: (req.body?.email || "unknown@local")
        .toString()
        .trim()
        .toLowerCase(),
      addressLabel: addressLabel.trim(),
      placeId,
      lat,
      lng,
      planningSnapshot: null,
      inputsHash,
    });
  }

  // If already ready, return quickly
  if (row.status === "ready" && row.pdf_url) {
    return res.json({
      ok: true,
      token: row.token,
      status: "ready",
      pdfUrl: row.pdf_url,
    });
  }

  // Start job (in-process). For production-hardening, replace with a real queue/worker.
  if (!inFlight.has(token)) {
    inFlight.add(token);

    setImmediate(async () => {
      try {
        await markReportRunningV2({ token });

        const result = await generateTownPlannerReportV2({
          token,
          addressLabel: addressLabel.trim(),
          placeId,
          lat,
          lng,
        });

        await markReportReadyV2({
          token,
          pdfKey: result.pdfKey,
          pdfUrl: result.pdfUrl,
          reportJson: result.reportJson,
        });
      } catch (e) {
        await markReportFailedV2({
          token,
          errorMessage: e?.message || String(e),
        });
      } finally {
        inFlight.delete(token);
      }
    });
  }

  return res.json({ ok: true, token, status: "running" });
});

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
      planningSnapshot: row.planning_snapshot,
      status: row.status,
      pdfUrl: row.pdf_url || null,
      errorMessage: row.error_message || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
