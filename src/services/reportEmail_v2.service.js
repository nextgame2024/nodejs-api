import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function buildHtml({ addressLabel, viewUrl }) {
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.4;">
      <h2>Your Property Report is ready</h2>
      <p>Address: <strong>${escapeHtml(addressLabel)}</strong></p>
      <p>Click below to view your report:</p>
      <p>
        <a href="${viewUrl}" style="display:inline-block;padding:10px 16px;border-radius:6px;text-decoration:none;background:#4CAF50;color:#fff;">
          View Report
        </a>
      </p>
      <p style="color:#666;font-size:12px;">
        If you didn’t request this, you can ignore this email.
      </p>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendViaSES({ to, subject, html }) {
  const fromEmail = requireEnv("SES_FROM_EMAIL"); // e.g. noreply@yourdomain.com
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

export async function sendReportLinkEmailV2({
  toEmail,
  addressLabel,
  viewUrl,
}) {
  const provider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();

  const subject = "Your Property Report";
  const html = buildHtml({ addressLabel, viewUrl });

  if (provider === "log") {
    console.log("[email_v2][LOG] To:", toEmail);
    console.log("[email_v2][LOG] Subject:", subject);
    console.log("[email_v2][LOG] Link:", viewUrl);
    return;
  }

  if (provider === "smtp") {
    await sendViaSMTP({ to: toEmail, subject, html });
    return;
  }

  // default SES
  await sendViaSES({ to: toEmail, subject, html });
}
