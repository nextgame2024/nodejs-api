import crypto from "crypto";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import {
  createReportRequestV2,
  getReportRequestByTokenV2,
  markReportRequestStatusV2,
  findReadyReportByHashV2,
  findLatestReportForLocationV2,
  refreshReportRequestContextV2,
  markReportRunningV2,
  markReportReadyV2,
  markReportFailedV2,
} from "../models/townplanner_v2.model.js";

import { sendReportLinkEmailV2 } from "../services/reportEmail_v2.service.js";
import {
  autocompleteAddresses,
  getPlaceDetails,
} from "../services/googlePlaces_v2.service.js";
import { fetchPlanningDataV2 } from "../services/planningData_v2.service.js";

import {
  generateTownPlannerReportV2,
  computeInputsHashV2,
  REPORT_TEMPLATE_VERSION,
} from "../services/townplanner_report_v2.service.js";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

// In-process guard (DB status is still source of truth)
const inFlight = new Set();

function isCachedPdfCurrent(cachedRow) {
  const reportVersion =
    cachedRow?.report_json?.templateVersion ||
    cachedRow?.report_json?.template_version ||
    null;
  if (reportVersion) {
    return String(reportVersion) === String(REPORT_TEMPLATE_VERSION);
  }
  // Fallback for old rows that only expose version in key path.
  const key = String(cachedRow?.pdf_key || "");
  return key.includes(REPORT_TEMPLATE_VERSION);
}

export const generateReportV2Controller = asyncHandler(async (req, res) => {
  const {
    token: tokenFromBody,
    addressLabel,
    placeId = null,
    lat,
    lng,
    lotPlan = null,
    force = false,
    email = "unknown@local",
    planningSnapshot = null,
  } = req.body || {};

  if (typeof lat !== "number" || typeof lng !== "number") {
    res.status(400);
    throw new Error("lat/lng must be numbers");
  }
  if (!addressLabel || typeof addressLabel !== "string") {
    res.status(400);
    throw new Error("Missing addressLabel");
  }

  const schemeVersion =
    process.env.CITY_PLAN_SCHEME_VERSION || "City Plan 2014";

  // CRITICAL: include template version so cache is invalidated when PDF changes
  const inputsHash = computeInputsHashV2({
    addressLabel: addressLabel.trim(),
    placeId: placeId || null,
    lat,
    lng,
    lotPlan: lotPlan || null,
    schemeVersion,
    templateVersion: REPORT_TEMPLATE_VERSION,
  });

  // Reuse existing ready report for identical inputs (unless forced)
  if (!force) {
    const cached = await findReadyReportByHashV2(inputsHash);
    // SAFETY: if cached PDF exists but is from a different engine version, regenerate
    if (cached?.pdf_url && isCachedPdfCurrent(cached)) {
      return res.json({
        ok: true,
        token: cached.token,
        status: "ready",
        pdfUrl: cached.pdf_url,
        cached: true,
        templateVersion: REPORT_TEMPLATE_VERSION,
      });
    }
  }

  const normalizedAddressLabel = addressLabel.trim();
  const normalizedEmail = String(email || "unknown@local")
    .trim()
    .toLowerCase();

  let token = tokenFromBody || null;
  let row = token ? await getReportRequestByTokenV2(token) : null;

  // Location-level reuse:
  // If same location is requested again, reuse the same row/token and overwrite it.
  if (!row && !token) {
    row = await findLatestReportForLocationV2({
      placeId: placeId || null,
      addressLabel: normalizedAddressLabel,
      lat,
      lng,
    });
    if (row?.token) token = row.token;
  }

  if (!token) token = crypto.randomUUID();

  // Ensure DB row exists
  if (!row) {
    row = await createReportRequestV2({
      token,
      email: normalizedEmail,
      addressLabel: normalizedAddressLabel,
      placeId,
      lat,
      lng,
      planningSnapshot: planningSnapshot || null,
      inputsHash,
    });
  } else {
    row =
      (await refreshReportRequestContextV2({
        token,
        email: normalizedEmail,
        addressLabel: normalizedAddressLabel,
        placeId,
        lat,
        lng,
        planningSnapshot: planningSnapshot || null,
        inputsHash,
      })) || row;
  }

  // If already ready, return (NOTE: this is token-based, not hash-based; keep behavior)
  if (
    !force &&
    row.status === "ready" &&
    row.pdf_url &&
    row.inputs_hash === inputsHash &&
    isCachedPdfCurrent(row)
  ) {
    return res.json({
      ok: true,
      token: row.token,
      status: "ready",
      pdfUrl: row.pdf_url,
      templateVersion: REPORT_TEMPLATE_VERSION,
    });
  }

  // Launch async job in-process
  if (!inFlight.has(token)) {
    inFlight.add(token);

    setImmediate(async () => {
      try {
        await markReportRunningV2({ token });

        const result = await generateTownPlannerReportV2({
          token,
          addressLabel: normalizedAddressLabel,
          placeId,
          lat,
          lng,
          lotPlan: lotPlan || null,
          planningSnapshot:
            planningSnapshot || row?.planning_snapshot || null,
        });

        await markReportReadyV2({
          token,
          pdfKey: result.pdfKey,
          pdfUrl: result.pdfUrl,
          reportJson: result.reportJson,
          inputsHash,
          planningSnapshot: result.planningSnapshot || null,
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

  return res.json({
    ok: true,
    token,
    status: "running",
    templateVersion: REPORT_TEMPLATE_VERSION,
  });
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
      planningSnapshot: null,
      inputsHash: null,
    });

    const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || "").replace(
      /\/$/,
      ""
    );
    if (!frontendBaseUrl) {
      res.status(500);
      throw new Error("Missing FRONTEND_BASE_URL env var");
    }

    const viewUrl = `${frontendBaseUrl}/townplanner/report/${row.token}`;

    await markReportRequestStatusV2({ token: row.token, status: "sending" });

    await sendReportLinkEmailV2({
      toEmail: row.email,
      addressLabel: row.address_label,
      viewUrl,
    });

    await markReportRequestStatusV2({ token: row.token, status: "sent" });

    res.json({ ok: true, token: row.token });
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
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      templateVersion: REPORT_TEMPLATE_VERSION,
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

  let planning = null;
  try {
    if (typeof details?.lat === "number" && typeof details?.lng === "number") {
      planning = await fetchPlanningDataV2({
        lat: details.lat,
        lng: details.lng,
      });
    }
  } catch (e) {
    console.error(
      "[townplanner_v2] planning enrichment failed:",
      e?.message || e
    );
  }

  res.json({ ...details, planning });
});
