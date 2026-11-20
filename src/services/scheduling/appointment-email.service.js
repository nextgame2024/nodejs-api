import { preparationConfigs, confirmedEmail } from "./meeting-preparation.js";
const sendFormEmail = async (...args) =>
  (await import("../leads/form-email.service.js")).sendFormEmail(...args);
const s = "sophia_runtime";
export async function queueAppointmentEmails(db, tenant, lead) {
  const config = preparationConfigs()[tenant];
  if (!config || !(await confirmedEmail(db, tenant, lead))) return;
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.appointment_email_outbox') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    return;
  const appointments = (
    await db.query(
      `SELECT * FROM ${s}.lead_appointments WHERE customer_id=$1 AND lead_id=$2 AND status='confirmed' AND starts_at>now()`,
      [tenant, lead.lead_id],
    )
  ).rows;
  for (const a of appointments)
    await db.query(
      `INSERT INTO ${s}.appointment_email_outbox(customer_id,appointment_id,appointment_version,recipient,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [
        tenant,
        a.appointment_id,
        a.version,
        lead.email.trim(),
        JSON.stringify({
          bookingConfirmation: true,
          confirmationOnly: true,
          formName: "Sophia AI discovery meeting",
          name: lead.display_name,
          language: lead.language,
          preparationUrl: config.url,
          appointment: {
            startsAt: a.starts_at,
            endsAt: a.ends_at,
            timezone: a.customer_timezone,
          },
        }),
      ],
    );
}
// At-least-once delivery, matching the existing form-email workflow. Locks keep
// concurrent workers from sending the same queued confirmation simultaneously.
export async function processAppointmentEmail(
  db,
  tenant,
  send = sendFormEmail,
) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE sophia_runtime_app");
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenant]);
    if (
      !(
        await db.query(
          "SELECT to_regclass('sophia_runtime.appointment_email_outbox') IS NOT NULL AS ready",
        )
      ).rows[0].ready
    ) {
      await db.query("COMMIT");
      return "idle";
    }
    const row = (
      await db.query(
        `SELECT * FROM ${s}.appointment_email_outbox WHERE customer_id=$1 AND sent_at IS NULL AND cancelled_at IS NULL AND attempts<5 AND available_at<=now() ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenant],
      )
    ).rows[0];
    if (!row) {
      await db.query("COMMIT");
      return "idle";
    }
    const a = (
      await db.query(
        `SELECT * FROM ${s}.lead_appointments WHERE customer_id=$1 AND appointment_id=$2 FOR SHARE`,
        [tenant, row.appointment_id],
      )
    ).rows[0];
    const lead = (
      await db.query(
        `SELECT * FROM ${s}.assistant_leads WHERE customer_id=$1 AND lead_id=$2 FOR SHARE`,
        [tenant, a.lead_id],
      )
    ).rows[0];
    const valid =
      a.status === "confirmed" &&
      a.version === row.appointment_version &&
      Date.parse(a.starts_at) > Date.now() &&
      lead.email?.trim() === row.recipient &&
      (await confirmedEmail(db, tenant, lead));
    let status = "cancelled";
    if (valid) {
      try {
        await send(row.recipient, row.payload);
        status = "sent";
      } catch {
        status = "retry";
      }
    }
    await db.query(
      `UPDATE ${s}.appointment_email_outbox SET attempts=attempts+1,sent_at=CASE WHEN $5='sent' THEN now() ELSE NULL END,cancelled_at=CASE WHEN $5='cancelled' THEN now() ELSE NULL END,available_at=now()+interval '5 minutes' WHERE customer_id=$1 AND appointment_id=$2 AND appointment_version=$3 AND recipient=$4`,
      [
        tenant,
        row.appointment_id,
        row.appointment_version,
        row.recipient,
        status,
      ],
    );
    await db.query("COMMIT");
    return status;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
