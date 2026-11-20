import { processAppointmentEmail } from "../scheduling/appointment-email.service.js";
import pool from "../../config/db.js";
import { processFormEmail } from "./form-email.service.js";
// The connection's owner role reads only the tenant registry. Delivery data is
// always processed by processFormEmail under sophia_runtime_app and tenant RLS.
export function startFormEmailWorkflow({
  database = pool,
  deliver = processFormEmail,
  deliverAppointment = processAppointmentEmail,
  logger = console,
  intervalMs = 15000,
} = {}) {
  let stopped = false,
    timer,
    cursor = null;
  async function cycle() {
    const db = await database.connect();
    try {
      const ready = (
        await db.query(
          "SELECT to_regclass('sophia_runtime.lead_form_email_outbox') IS NOT NULL AS ready",
        )
      ).rows[0].ready;
      if (!ready) return;
      const tenants = (
        await db.query(
          "SELECT customer_id FROM sophia_runtime.customers WHERE status='active' AND ($1::uuid IS NULL OR customer_id>$1) ORDER BY customer_id LIMIT 50",
          [cursor],
        )
      ).rows;
      for (const tenant of tenants) {
        if (stopped) break;
        await deliver(db, tenant.customer_id);
        await deliverAppointment(db, tenant.customer_id);
        cursor = tenant.customer_id;
      }
      if (tenants.length < 50) cursor = null;
    } finally {
      db.release();
    }
  }
  async function run() {
    try {
      await cycle();
    } catch {
      logger.error("[FORM_EMAIL] Delivery cycle failed; will retry.");
    }
    if (!stopped) {
      timer = setTimeout(run, intervalMs);
      timer.unref?.();
    }
  }
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
