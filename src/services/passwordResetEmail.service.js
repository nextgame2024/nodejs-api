import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const LOGO_URL =
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/company-logos/1776856137438-cjet9pj1u6u.png";
const DEFAULT_FROM = "Sophia AI <hello@sophiaai.com.au>";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function clientUrl(path = "/") {
  const base = String(
    process.env.CLIENT_URL || "https://sophiaai.com.au",
  ).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function firstNameFrom({ name, username, email }) {
  const value = String(name || username || email || "").trim();
  const first = value.split(/\s+/)[0] || value.split("@")[0] || "there";
  return first
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function resetUrlFor(token) {
  return clientUrl(`/login/reset-password?token=${encodeURIComponent(token)}`);
}

function buildPasswordResetHtml({ user, token }) {
  const firstName = firstNameFrom(user);
  const resetUrl = resetUrlFor(token);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Reset your Sophia AI password</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f7fb;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:32px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #dbe4f0;border-radius:20px;overflow:hidden;border-collapse:separate;">
            <tr>
              <td style="padding:30px;background:linear-gradient(135deg,#e6fbff 0%,#f4f0ff 100%);">
                <img src="${LOGO_URL}" width="128" alt="Sophia AI" style="display:block;width:128px;max-width:60%;height:auto;margin:0 0 20px;">
                <div style="font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5;">Password reset</div>
                <h1 style="margin:12px 0 0;color:#07112b;font-size:30px;line-height:1.15;">Reset your password</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 30px;color:#334155;">
                <p style="margin:0 0 14px;font-size:16px;line-height:1.65;">Hi ${escapeHtml(
                  firstName,
                )},</p>
                <p style="margin:0 0 14px;font-size:16px;line-height:1.65;">We received a request to reset the password for your Sophia AI account.</p>
                <p style="margin:0 0 22px;font-size:16px;line-height:1.65;">Use the secure link below to choose a new password. This link expires in 1 hour.</p>
                <a href="${escapeHtml(
                  resetUrl,
                )}" style="display:inline-block;background:linear-gradient(90deg,#23c8d2,#7047f7);color:#ffffff;text-decoration:none;border-radius:12px;padding:14px 22px;font-weight:800;font-size:15px;">Reset password</a>
                <p style="margin:24px 0 0;color:#64748b;font-size:13px;line-height:1.6;">If you did not request this, you can safely ignore this email. Your password will not change until a new one is submitted.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendViaSES({ from, to, subject, html }) {
  const region = process.env.AWS_REGION || "ap-southeast-2";
  const client = new SESv2Client({ region });

  await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Html: { Data: html, Charset: "UTF-8" } },
        },
      },
    }),
  );
}

async function sendViaSMTP({ from, to, subject, html }) {
  const transport = nodemailer.createTransport({
    host: requireEnv("SMTP_HOST"),
    port: Number(requireEnv("SMTP_PORT")),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  await transport.sendMail({ from, to, subject, html });
}

export async function sendPasswordResetEmail({ user, token }) {
  if (!user?.email) throw new Error("user.email is required");
  if (!token) throw new Error("token is required");

  const provider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();
  const from = process.env.PASSWORD_RESET_EMAIL_FROM || DEFAULT_FROM;
  const subject = "Reset your Sophia AI password";
  const html = buildPasswordResetHtml({ user, token });

  if (provider === "log") {
    console.log("[password-reset-email][LOG] To:", user.email);
    console.log("[password-reset-email][LOG] Subject:", subject);
    console.log("[password-reset-email][LOG] Link:", resetUrlFor(token));
    return { sent: true, provider };
  }

  if (provider === "smtp") {
    await sendViaSMTP({ from, to: user.email, subject, html });
    return { sent: true, provider };
  }

  await sendViaSES({ from, to: user.email, subject, html });
  return { sent: true, provider };
}
