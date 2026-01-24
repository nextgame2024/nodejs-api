import crypto from "crypto";
import asyncHandler from "express-async-handler";

import {
  computeInputsHashV2,
  generateTownPlannerReportV2,
} from "./townplanner_report_v2.service.js";
import {
  createReportRequestV2,
  findReadyReportByHashV2,
  getReportRequestV2,
  updateReportRequestV2,
} from "./townplanner_v2.model.js";

// In-process guard (DB status is still source of truth)
const inFlight = new Set();

function isSameUtcDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return da.toISOString().slice(0, 10) === db.toISOString().slice(0, 10);
}

export const generateReportV2Controller = asyncHandler(async (req, res) => {
  const {
    token: tokenFromBody,
    addressLabel,
    placeId,
    lat,
    lng,
    // client can request a "force" refresh; otherwise we use cache rules
    force = false,
  } = req.body || {};

  if (
    !addressLabel ||
    !placeId ||
    typeof lat !== "number" ||
    typeof lng !== "number"
  ) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: addressLabel, placeId, lat, lng",
    });
  }

  const schemeVersion =
    process.env.CITY_PLAN_SCHEME_VERSION || "City Plan 2014";

  // Bump this env var whenever the PDF layout changes to avoid serving a stale
  // cached PDF for identical inputs.
  const reportTemplateVersion =
    process.env.REPORT_TEMPLATE_VERSION ||
    process.env.PDF_ENGINE_VERSION ||
    "TPR-PDFKIT-V3";

  const inputsHash = computeInputsHashV2({
    addressLabel,
    placeId,
    lat,
    lng,
    schemeVersion,
    reportTemplateVersion,
  });

  // 1) Prefer same-day cached report for identical inputs (unless forced)
  if (!force) {
    const cached = await findReadyReportByHashV2(inputsHash);
    if (cached?.pdf_url) {
      return res.json({
        ok: true,
        status: "ready",
        token: cached.token,
        pdfUrl: cached.pdf_url,
        cached: true,
      });
    }
  }

  // Token handling:
  // - If the client reuses an old token, we may have an old "ready" row from a previous day.
  // - We must not return that stale PDF (rule: cache only same day), and we also should not
  //   overwrite that historical row. Instead, we mint a fresh token.
  let token = tokenFromBody || crypto.randomUUID();

  let row = tokenFromBody ? await getReportRequestV2(tokenFromBody) : null;

  if (row?.status === "ready" && row?.pdf_url) {
    const today = new Date();
    const isFresh = row.updated_at && isSameUtcDay(row.updated_at, today);

    if (isFresh && !force) {
      // Already handled by inputsHash cache, but keep as safety net for token-based clients.
      return res.json({
        ok: true,
        status: "ready",
        token: row.token,
        pdfUrl: row.pdf_url,
        cached: true,
      });
    }

    // Stale -> mint a new token + new row
    const freshToken = crypto.randomUUID();
    row = await createReportRequestV2({
      token: freshToken,
      addressLabel,
      placeId,
      lat,
      lng,
      status: "queued",
      pdfUrl: null,
      pdfKey: null,
      reportJson: null,
      planningSnapshot: null,
      inputsHash,
    });

    // Ensure downstream logic uses the fresh token.
    req.body.token = freshToken;
    token = freshToken;
  }

  // If no existing row or row not usable, ensure there is a DB row
  if (!row) {
    row = await createReportRequestV2({
      token,
      addressLabel,
      placeId,
      lat,
      lng,
      status: "queued",
      pdfUrl: null,
      pdfKey: null,
      reportJson: null,
      planningSnapshot: null,
      inputsHash,
    });
  } else if (row.status === "running" || row.status === "queued") {
    // If it's already in progress, return early.
    return res.json({
      ok: true,
      status: row.status,
      token: row.token,
      pdfUrl: row.pdf_url || null,
      cached: false,
    });
  } else {
    // Ensure hash is current (template version or scheme changes can alter hash)
    if (row.inputs_hash !== inputsHash) {
      await updateReportRequestV2(row.token, {
        inputs_hash: inputsHash,
        status: "queued",
        pdf_url: null,
        pdf_key: null,
        report_json: null,
        planning_snapshot: null,
      });
      row = await getReportRequestV2(row.token);
    }
  }

  // 2) Launch async job in-process (fire-and-forget)
  if (!inFlight.has(token)) {
    inFlight.add(token);

    setImmediate(async () => {
      try {
        const token = req.body.token || crypto.randomUUID();

        await updateReportRequestV2(token, { status: "running" });

        const result = await generateTownPlannerReportV2({
          token,
          addressLabel,
          placeId,
          lat,
          lng,
          schemeVersion,
          reportTemplateVersion,
        });

        await updateReportRequestV2(token, {
          status: "ready",
          pdf_url: result.pdfUrl,
          pdf_key: result.pdfKey,
          report_json: result.reportJson,
          planning_snapshot: result.planningSnapshot,
        });
      } catch (err) {
        const token = req.body.token;
        if (token) {
          await updateReportRequestV2(token, {
            status: "failed",
          });
        }
        console.error("[townplanner_v2] report generation failed:", err);
      } finally {
        inFlight.delete(req.body.token);
      }
    });
  }

  return res.json({
    ok: true,
    status: "queued",
    token,
    pdfUrl: null,
    cached: false,
  });
});
