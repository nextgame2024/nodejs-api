import os from "os";
import crypto from "crypto";

import * as workerModel from "../models/bm.propertyReportWorker.model.js";
import { findReadyReportByHashV2 } from "../models/townplanner_v2.model.js";
import {
  computeInputsHashV2,
  generateTownPlannerReportV2,
} from "./townplanner_report_v2.service.js";
import {
  PLANNING_SNAPSHOT_VERSION,
  REPORT_TEMPLATE_VERSION,
} from "./townplannerReportVersions.js";

const defaultWorkerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function propertyReportWorkerConfig(env = process.env) {
  return {
    lockId: positiveNumber(env.PROPERTY_REPORT_WORKER_LOCK_ID, 74622032),
    leaseSeconds: positiveNumber(env.PROPERTY_REPORT_LEASE_SECONDS, 900),
    maxInitialAttempts: positiveNumber(
      env.PROPERTY_REPORT_MAX_INITIAL_ATTEMPTS,
      3,
    ),
    retryDelaySeconds: positiveNumber(
      env.PROPERTY_REPORT_RETRY_DELAY_SECONDS,
      120,
    ),
    dailyRetryDelaySeconds: positiveNumber(
      env.PROPERTY_REPORT_DAILY_RETRY_SECONDS,
      86400,
    ),
  };
}

export async function findReusableTownPlannerReport(inputs) {
  const inputsHash = computeInputsHashV2({
    addressLabel: inputs.addressLabel,
    placeId: inputs.placeId || null,
    lat: inputs.lat,
    lng: inputs.lng,
    lotPlan: inputs.lotPlan || null,
    schemeVersion: process.env.CITY_PLAN_SCHEME_VERSION || "City Plan 2014",
    templateVersion: REPORT_TEMPLATE_VERSION,
  });
  const cached = await findReadyReportByHashV2(inputsHash);
  const templateVersion = cached?.report_json?.templateVersion;
  const planningVersion = cached?.report_json?.planning?.planningDataVersion;
  if (
    !cached?.pdf_key ||
    !cached?.pdf_url ||
    templateVersion !== REPORT_TEMPLATE_VERSION ||
    planningVersion !== PLANNING_SNAPSHOT_VERSION
  ) {
    return null;
  }
  return { pdfKey: cached.pdf_key, pdfUrl: cached.pdf_url };
}

export async function processPropertyReportCycle({
  model = workerModel,
  generateReport = generateTownPlannerReportV2,
  findCachedReport = findReusableTownPlannerReport,
  workerId = defaultWorkerId,
  config = propertyReportWorkerConfig(),
} = {}) {
  const lock = await model.acquireWorkerLock(config.lockId);
  if (!lock) return { status: "lock_busy" };

  try {
    const recovered = await model.recoverExpiredJobs(config.maxInitialAttempts);
    const job = await model.claimNextJob({
      workerId,
      leaseSeconds: config.leaseSeconds,
    });
    if (!job) return { status: "idle", recovered };

    const heartbeatMs = Math.max(10_000, Math.floor(config.leaseSeconds * 1000 / 3));
    const heartbeat = setInterval(() => {
      model.renewLease({
        reportJobId: job.reportJobId,
        workerId,
        leaseSeconds: config.leaseSeconds,
      }).catch((error) => {
        console.error("[PROPERTY_REPORT] Lease renewal failed:", error?.message || error);
      });
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      const inputs = job.reportInputs || {};
      if (!Number.isFinite(inputs.lat) || !Number.isFinite(inputs.lng)) {
        throw new Error("Property latitude and longitude are required");
      }
      let cachedReport = null;
      try {
        cachedReport = await findCachedReport(inputs);
      } catch (error) {
        console.warn(
          "[PROPERTY_REPORT] Existing-report cache lookup failed:",
          error?.message || error,
        );
      }
      const result = cachedReport || await generateReport({
        token: job.reportJobId,
        addressLabel: inputs.addressLabel,
        placeId: inputs.placeId || null,
        lat: inputs.lat,
        lng: inputs.lng,
        lotPlan: inputs.lotPlan || null,
        planningSnapshot: null,
      });
      await model.markJobReady({
        reportJobId: job.reportJobId,
        workerId,
        result,
      });
      return { status: "ready", reportJobId: job.reportJobId, recovered };
    } catch (error) {
      const message = String(error?.message || error || "PDF generation failed").slice(0, 2000);
      const failure = await model.markJobFailed({
        reportJobId: job.reportJobId,
        workerId,
        errorMessage: message,
        maxInitialAttempts: config.maxInitialAttempts,
        retryDelaySeconds:
          config.retryDelaySeconds * (2 ** Math.max(0, job.attemptCount - 1)),
        dailyRetryDelaySeconds: config.dailyRetryDelaySeconds,
      });
      return {
        status: failure.initialAttemptsExhaustedAt ? "daily_retry" : "retry",
        reportJobId: job.reportJobId,
        attemptCount: failure.attemptCount,
        error: message,
        recovered,
      };
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    await lock.release();
  }
}
