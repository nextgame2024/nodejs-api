import { ensureTownPlannerBookingWorkflowSchema } from "../config/startupMigrations.js";
import { processPropertyReportCycle } from "./bm.propertyReportWorker.service.js";
import { processInspectionEmailCycle } from "./bm.inspectionEmailWorker.service.js";

function pollInterval(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Run in both the API and the dedicated worker. PostgreSQL advisory locks in
// each processor keep report generation and email delivery globally serial.
export function startInspectionWorkflow({
  ensureSchema = ensureTownPlannerBookingWorkflowSchema,
  reportCycle = processPropertyReportCycle,
  emailCycle = processInspectionEmailCycle,
  env = process.env,
  logger = console,
} = {}) {
  let stopped = false;
  const waits = new Map();
  const reportMs = pollInterval(env.PROPERTY_REPORT_WORKER_LOOP_MS, 30_000);
  const emailMs = pollInterval(env.INSPECTION_EMAIL_WORKER_LOOP_MS, 15_000);

  function wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waits.delete(timer);
        resolve();
      }, ms);
      waits.set(timer, resolve);
    });
  }

  async function loop(label, cycle, interval, completedStatuses) {
    while (!stopped) {
      try {
        const result = await cycle();
        if (result.status !== "idle" && result.status !== "lock_busy") {
          logger.log(`[${label}]`, result);
        }
        if (completedStatuses.includes(result.status)) continue;
      } catch (error) {
        logger.error(`[${label}] Worker cycle failed:`, error?.message || error);
      }
      if (!stopped) await wait(interval);
    }
  }

  const done = (async () => {
    while (!stopped) {
      try {
        await ensureSchema();
        break;
      } catch (error) {
        logger.error("[INSPECTION_WORKFLOW] Schema initialization failed; retrying:", error?.message || error);
        if (!stopped) await wait(reportMs);
      }
    }
    if (stopped) return;
    logger.log(`[INSPECTION_WORKFLOW] Started (report poll ${reportMs}ms, email poll ${emailMs}ms).`);
    await Promise.all([
      loop("PROPERTY_REPORT", reportCycle, reportMs, ["ready"]),
      loop("INSPECTION_EMAIL", emailCycle, emailMs, ["sent", "fallback_sent"]),
    ]);
  })();

  return {
    done,
    async stop() {
      stopped = true;
      for (const [timer, resolve] of waits) {
        clearTimeout(timer);
        resolve();
      }
      waits.clear();
      await done;
    },
  };
}
