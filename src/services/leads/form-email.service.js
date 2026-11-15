import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { richAnswerText } from "./public-lead-forms.service.js";
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function formEmailMessage(payload) {
  const lines = [
    payload.formName,
    `Name: ${payload.contact.displayName ?? payload.contact.name ?? ""}`,
    `Email: ${payload.contact.email}`,
    `Phone: ${payload.contact.phone || ""}`,
    ...payload.answers.map(
      (a) =>
        `${a.label}: ${Array.isArray(a.value) ? a.value.join(", ") : a.format === "html" ? richAnswerText(a.value) : a.value}`,
    ),
  ];
  if (payload.appointment)
    lines.push(
      `Appointment: ${payload.appointment.startsAt} – ${payload.appointment.endsAt} (${payload.appointment.timezone})`,
    );
  return {
    subject: `New form response: ${payload.formName}`.replace(/[\r\n]/g, " "),
    html: `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif">${escape(lines.join("\n\n"))}</pre>`,
  };
}
export async function sendFormEmail(recipient, payload) {
  const message = formEmailMessage(payload);
  const provider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();
  if (provider === "log") return; // Development only; never print customer responses.
  if (provider === "smtp") {
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM_EMAIL)
      throw new Error("SMTP is not configured");
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      connectionTimeout: 10000,
      socketTimeout: 20000,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    const result = await transport.sendMail({
      from: process.env.SMTP_FROM_EMAIL,
      to: recipient,
      ...message,
    });
    if (result.rejected?.length) throw new Error("Recipient was rejected");
    return;
  }
  if (provider !== "ses" || !process.env.SES_FROM_EMAIL)
    throw new Error("Email provider is not configured");
  await new SESv2Client({
    region: process.env.AWS_REGION || "ap-southeast-2",
  }).send(
    new SendEmailCommand({
      FromEmailAddress: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [recipient] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: { Html: { Data: message.html, Charset: "UTF-8" } },
        },
      },
    }),
    { abortSignal: AbortSignal.timeout(20000) },
  );
}
// Each delivery uses tenant RLS and a row lock; separate workers skip locked rows.
// Delivery is at-least-once: an SMTP acceptance followed by a process crash may be retried.
export async function processFormEmail(db, tenant, send = sendFormEmail) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE sophia_runtime_app");
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenant]);
    const row = (
      await db.query(
        `SELECT * FROM sophia_runtime.lead_form_email_outbox WHERE customer_id=$1 AND sent_at IS NULL AND attempts<5 AND available_at<=now() ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenant],
      )
    ).rows[0];
    if (!row) {
      await db.query("COMMIT");
      return "idle";
    }
    let sent = false;
    try {
      await send(row.recipient, row.payload);
      sent = true;
    } catch {
      /* Retry without logging customer data or provider secrets. */
    }
    await db.query(
      `UPDATE sophia_runtime.lead_form_email_outbox SET attempts=attempts+1,sent_at=CASE WHEN $4 THEN now() ELSE NULL END,available_at=now()+interval '5 minutes' WHERE customer_id=$1 AND submission_id=$2 AND recipient=$3`,
      [tenant, row.submission_id, row.recipient, sent],
    );
    await db.query("COMMIT");
    return sent ? "sent" : "retry";
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
