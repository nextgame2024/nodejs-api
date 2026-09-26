import os from "os";
import crypto from "crypto";

import * as workerModel from "../models/bm.propertyReportWorker.model.js";
import { generateTownPlannerReportV2 } from "./townplanner_report_v2.service.js";

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

export async function processPropertyReportCycle({
  model = workerModel,
  generateReport = generateTownPlannerReportV2,
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
        claimToken: job.claimToken,
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
      const result = await generateReport({
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
        claimToken: job.claimToken,
        result,
      });
      return { status: "ready", reportJobId: job.reportJobId, recovered };
    } catch (error) {
      const message = String(error?.message || error || "PDF generation failed").slice(0, 2000);
      const failure = await model.markJobFailed({
        reportJobId: job.reportJobId,
        workerId,
        claimToken: job.claimToken,
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
