import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { richAnswerText } from "./public-lead-forms.service.js";
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const LOGO_URL =
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/company-logos/1776856137438-cjet9pj1u6u.png";
export function appointmentEmailLabel(appointment, language = "en") {
  const locale = { en: "en-AU", es: "es", pt: "pt-BR" }[language] || "en-AU";
  const timezone = appointment.timezone;
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(appointment.startsAt));
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(appointment.startsAt));
  const weekday = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "long",
  }).format(new Date(appointment.startsAt));
  const at = { es: "a las", pt: "às" }[language] || "at";
  return `${weekday}, ${date} ${at} ${time} (${timezone})`;
}
export function formEmailMessage(payload) {
  const confirmation = payload.confirmationOnly || payload.includeConfirmation;
  const booking = payload.bookingConfirmation === true;
  const words = {
    en: {
      title: "Your appointment is confirmed",
      greeting: `Hi ${payload.name || "there"},`,
      intro:
        "Thanks for booking a conversation with Sophia AI. We look forward to learning more about your business.",
      prepare:
        "Before we meet, please complete this short form. It will help us understand your priorities and make our meeting more useful for you.",
      button: "Prepare for our meeting",
      close: "Thank you—we look forward to speaking with you!",
    },
    es: {
      title: "Tu cita está confirmada",
      greeting: `Hola ${payload.name || ""},`,
      intro:
        "Gracias por reservar una conversación con Sophia AI. Nos encantará conocer mejor tu negocio.",
      prepare:
        "Antes de reunirnos, completa este breve formulario. Nos ayudará a entender tus prioridades y aprovechar mejor la reunión.",
      button: "Preparar nuestra reunión",
      close: "¡Gracias! Nos vemos pronto.",
    },
    pt: {
      title: "Sua reunião está confirmada",
      greeting: `Olá ${payload.name || ""},`,
      intro:
        "Obrigado por agendar uma conversa com a Sophia AI. Queremos conhecer melhor seu negócio.",
      prepare:
        "Antes da reunião, preencha este breve formulário para entendermos suas prioridades e aproveitarmos melhor nosso tempo juntos.",
      button: "Preparar nossa reunião",
      close: "Obrigado! Até breve.",
    },
  }[payload.language] || {
    title: "Your appointment is confirmed",
    greeting: `Hi ${payload.name || "there"},`,
    intro: "Thanks for booking a conversation with Sophia AI.",
    prepare:
      "Please complete this short form before we meet so we can understand your business and priorities.",
    button: "Prepare for our meeting",
    close: "We look forward to speaking with you!",
  };
  const title = booking
    ? words.title
    : confirmation
      ? "Thank you for telling us about your business!"
      : "New form response";
  const appointment = payload.appointment
    ? appointmentEmailLabel(payload.appointment, payload.language)
    : null;
  const paragraphs = booking
    ? [words.greeting, words.intro, words.prepare, words.close]
    : confirmation
      ? [
          ...(appointment
            ? [`Your appointment is confirmed for ${appointment}.`]
            : []),
          "Our team will review your answers to better understand your needs and identify relevant opportunities before we meet.",
          "We look forward to speaking with you.",
        ]
      : [];
  const answers = payload.confirmationOnly
    ? []
    : (payload.answers || []).map((a) => ({
        label: a.label,
        value: Array.isArray(a.value)
          ? a.value.join(", ")
          : a.format === "html"
            ? richAnswerText(a.value)
            : String(a.value ?? ""),
      }));
  const appointmentHtml = appointment
    ? `<div style="padding:20px;background:#e9faf6;border-left:4px solid #0aa58f;border-radius:8px;margin:22px 0;color:#123e37;">${booking ? escape(words.title) : confirmation ? "Your appointment is confirmed for" : "Appointment"}<br><strong>${escape(appointment)}</strong></div>`
    : "";
  const preparationUrl = booking ? new URL(payload.preparationUrl) : null;
  if (preparationUrl && preparationUrl.protocol !== "https:")
    throw new Error("Invalid preparation link");
  const button = preparationUrl
    ? `<p style="margin:24px 0;"><a href="${escape(preparationUrl.href)}" style="display:inline-block;background:#0aa58f;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:8px;">${escape(words.button)}</a></p>`
    : "";
  const body = `${appointmentHtml}${
    confirmation
      ? paragraphs
          .filter((p) => !p.startsWith("Your appointment"))
          .map(
            (p) => `<p style="margin:18px 0;line-height:1.7;">${escape(p)}</p>`,
          )
          .join("")
      : ""
  }${button}${answers.map((a) => `<div style="padding:20px 0;border-bottom:1px solid #e2e8f0;"><p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#475569;">${escape(a.label)}</p><div style="white-space:pre-wrap;line-height:1.7;color:#0f172a;">${escape(a.value)}</div></div>`).join("")}`;
  return {
    subject: booking
      ? `${words.title} — Sophia AI`
      : `${confirmation ? "Thank you for your response" : "New form response"}: ${payload.formName}`.replace(
          /[\r\n]/g,
          " ",
        ),
    text: [
      title,
      ...paragraphs,
      ...(booking
        ? [appointment, `${words.button}: ${preparationUrl.href}`]
        : []),
      ...(!confirmation && appointment ? [`Appointment: ${appointment}`] : []),
      ...answers.map((a) => `${a.label}\n${a.value}`),
    ].join("\n\n"),
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"></head><body style="margin:0;background:#eef4ff;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border:1px solid #dbe4f0;border-radius:18px;overflow:hidden;"><tr><td style="padding:28px;background:#f2f8ff;background:linear-gradient(135deg,#eefbff,#f5f3ff);"><img src="${LOGO_URL}" width="136" alt="Sophia AI" style="display:block;width:136px;height:auto;margin-bottom:24px;"><h1 style="font-size:26px;line-height:1.3;color:#07112b;margin:0;">${escape(title)}</h1>${!payload.confirmationOnly ? `<p style="color:#64748b;">${escape(payload.formName)}</p>` : ""}</td></tr><tr><td style="padding:8px 28px 28px;color:#334155;">${body}</td></tr><tr><td style="padding:22px;text-align:center;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;">Sophia AI</td></tr></table></td></tr></table></body></html>`,
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
  if (
    provider !== "ses" ||
    !(process.env.SES_FROM_EMAIL || process.env.SES_FROM)
  )
    throw new Error("Email provider is not configured");
  await new SESv2Client({
    region:
      process.env.AWS_REGION || process.env.SES_REGION || "ap-southeast-2",
  }).send(
    new SendEmailCommand({
      FromEmailAddress: process.env.SES_FROM_EMAIL || process.env.SES_FROM,
      Destination: { ToAddresses: [recipient] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: message.html, Charset: "UTF-8" },
            Text: { Data: message.text, Charset: "UTF-8" },
          },
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
