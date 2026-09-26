import os from "os";
import crypto from "crypto";

import * as workerModel from "../models/bm.propertyReportWorker.model.js";
import { getObjectBuffer } from "./s3.js";
import { sendInspectionConfirmationEmail } from "./bm.inspectionEmail.service.js";

const defaultWorkerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const inspectionTimeZone = process.env.BM_REAL_ESTATE_TIME_ZONE || "Australia/Brisbane";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function inspectionEmailWorkerConfig(env = process.env) {
  return {
    lockId: positiveNumber(env.INSPECTION_EMAIL_WORKER_LOCK_ID, 74622033),
    leaseSeconds: positiveNumber(env.INSPECTION_EMAIL_LEASE_SECONDS, 300),
    maxAttempts: positiveNumber(env.INSPECTION_EMAIL_MAX_ATTEMPTS, 3),
    retryDelaySeconds: positiveNumber(
      env.INSPECTION_EMAIL_RETRY_DELAY_SECONDS,
      120,
    ),
  };
}

export async function processInspectionEmailCycle({
  model = workerModel,
  loadReport = getObjectBuffer,
  sendEmail = sendInspectionConfirmationEmail,
  workerId = defaultWorkerId,
  config = inspectionEmailWorkerConfig(),
} = {}) {
  const lock = await model.acquireWorkerLock(config.lockId);
  if (!lock) return { status: "lock_busy" };

  try {
    const recovered = await model.recoverExpiredDeliveries();
    const delivery = await model.claimNextDelivery({
      workerId,
      leaseSeconds: config.leaseSeconds,
    });
    if (!delivery) return { status: "idle", recovered };

    const heartbeatMs = Math.max(10_000, Math.floor(config.leaseSeconds * 1000 / 3));
    const heartbeat = setInterval(() => {
      model.renewDeliveryLease({
        deliveryId: delivery.deliveryId,
        workerId,
        claimToken: delivery.claimToken,
        leaseSeconds: config.leaseSeconds,
      }).catch((error) => {
        console.error("[INSPECTION_EMAIL] Lease renewal failed:", error?.message || error);
      });
    }, heartbeatMs);
    heartbeat.unref?.();

    let providerSubmissionStarted = false;
    try {
      const booking = withInspectionTimeLabel(delivery);
      let reportAttachment = null;
      if (!delivery.fallbackWithoutReport) {
        if (delivery.reportStatus !== "ready" || !delivery.pdfKey) {
          throw new Error("Town Planner report is not ready for email delivery");
        }
        const content = await loadReport(delivery.pdfKey);
        if (!Buffer.isBuffer(content) || content.length === 0) {
          throw new Error("Town Planner report file is empty");
        }
        reportAttachment = {
          filename: reportFilename(delivery.propertyAddress),
          content,
        };
      }

      providerSubmissionStarted = true;
      const providerResult = await sendEmail(booking, {
        reportAttachment,
        reportPending: delivery.fallbackWithoutReport,
      });
      if (!providerResult || !["accepted", "preview"].includes(providerResult.state)) {
        throw new Error("Email provider did not return a bounded acceptance result");
      }
      const recorded = await model.markDeliveryAccepted({
        deliveryId: delivery.deliveryId,
        workerId,
        claimToken: delivery.claimToken,
        providerResult,
      });
      return {
        status: recorded.status,
        deliveryId: delivery.deliveryId,
        recovered,
      };
    } catch (error) {
      const message = String(error?.message || error || "Email delivery failed").slice(0, 2000);
      if (providerSubmissionStarted) {
        await model.markDeliveryOutcomeUnknown({
          deliveryId: delivery.deliveryId,
          workerId,
          claimToken: delivery.claimToken,
          errorMessage: message,
        });
        return { status: "outcome_unknown", deliveryId: delivery.deliveryId, error: message, recovered };
      }
      const failure = await model.markDeliveryFailed({
        deliveryId: delivery.deliveryId,
        workerId,
        claimToken: delivery.claimToken,
        errorMessage: message,
        maxAttempts: config.maxAttempts,
        retryDelaySeconds:
          config.retryDelaySeconds * (2 ** Math.max(0, delivery.attemptCount - 1)),
      });
      return {
        status: failure.status,
        deliveryId: delivery.deliveryId,
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

function withInspectionTimeLabel(booking) {
  const startsAt = new Date(booking.startsAt);
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
  return { ...booking, startsAtLabel: `${dateLabel}, ${timeLabel}` };
}

function reportFilename(address) {
  const slug = String(address || "property")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "property";
  return `town-planner-report-${slug}.pdf`;
}
