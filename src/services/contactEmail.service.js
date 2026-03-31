import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildHtml({ name, email, company, message }) {
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color:#0f172a;">
      <h2>New SophiaAi contact request</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Company:</strong> ${escapeHtml(company || "-")}</p>
      <p><strong>Message:</strong></p>
      <pre style="white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:8px;border:1px solid #e2e8f0;">${escapeHtml(
        message
      )}</pre>
    </div>
  `;
}

async function sendViaSES({ to, subject, html }) {
  const fromEmail = requireEnv("SES_FROM_EMAIL");
  const region = process.env.AWS_REGION || "ap-southeast-2";
  const client = new SESv2Client({ region });

  const cmd = new SendEmailCommand({
    FromEmailAddress: fromEmail,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Html: { Data: html, Charset: "UTF-8" } },
      },
    },
  });

  await client.send(cmd);
}

async function sendViaSMTP({ to, subject, html }) {
  const fromEmail = requireEnv("SMTP_FROM_EMAIL");

  const transport = nodemailer.createTransport({
    host: requireEnv("SMTP_HOST"),
    port: Number(requireEnv("SMTP_PORT")),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  await transport.sendMail({
    from: fromEmail,
    to,
    subject,
    html,
  });
}

export async function sendContactEmail({ name, email, company, message }) {
  const provider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();
  const toEmail = process.env.CONTACT_TO_EMAIL || "jlcm66@gmail.com";
  const subject = `SophiaAi contact from ${name || "Client"}`;
  const html = buildHtml({ name, email, company, message });

  if (provider === "log") {
    console.log("[contact][LOG] To:", toEmail);
    console.log("[contact][LOG] Subject:", subject);
    console.log("[contact][LOG] Name:", name);
    console.log("[contact][LOG] Email:", email);
    console.log("[contact][LOG] Company:", company);
    console.log("[contact][LOG] Message:", message);
    return;
  }

  if (provider === "smtp") {
    await sendViaSMTP({ to: toEmail, subject, html });
    return;
  }

  await sendViaSES({ to: toEmail, subject, html });
}
