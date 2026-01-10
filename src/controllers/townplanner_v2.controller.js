import crypto from "crypto";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import {
  createReportRequestV2,
  getReportRequestByTokenV2,
  markReportRequestStatusV2,
} from "../models/townplanner_v2.model.js";
import { sendReportLinkEmailV2 } from "../services/reportEmail_v2.service.js";

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
