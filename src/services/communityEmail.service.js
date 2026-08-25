import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { config } from "../config/index.js";

const LOGO_URL =
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/company-logos/1776856137438-cjet9pj1u6u.png";
const DEFAULT_FROM = "Sophia AI <hello@sophiaai.com.au>";
const DEFAULT_INTERNAL_COPY = "hello@sophiaai.com.au";
const DEFAULT_API_URL = "https://nodejs-api-hft7.onrender.com/api";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function apiUrl(path = "") {
  const base = String(
    process.env.PUBLIC_API_URL ||
      process.env.API_PUBLIC_URL ||
      process.env.API_URL ||
      DEFAULT_API_URL,
  ).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
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

export function createEmailUnsubscribeToken(user) {
  if (!user?.id) throw new Error("user.id is required");
  return jwt.sign(
    {
      purpose: "email_unsubscribe",
      userId: user.id,
      email: user.email || "",
    },
    config.jwt.secret,
  );
}

export function verifyEmailUnsubscribeToken(token) {
  const payload = jwt.verify(token, config.jwt.secret);
  if (payload?.purpose !== "email_unsubscribe" || !payload?.userId) {
    throw new Error("Invalid unsubscribe token");
  }
  return payload;
}

export function unsubscribeUrlFor(user) {
  const token = createEmailUnsubscribeToken(user);
  return apiUrl(`/emails/unsubscribe?token=${encodeURIComponent(token)}`);
}

function buildWelcomeCommunityHtml({ user }) {
  const firstName = firstNameFrom(user);
  const unsubscribeUrl = unsubscribeUrlFor(user);
  const dashboardUrl = clientUrl("/explore");
  const previewText =
    "Thank you for joining the Sophia AI community. We will send practical AI news, ideas, and useful updates.";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Welcome to the Sophia AI Community</title>
  </head>
  <body style="margin:0;padding:0;background:#edf7fb;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(
      previewText,
    )}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf7fb;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:34px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:660px;background:#ffffff;border:1px solid #dbeafe;border-radius:22px;overflow:hidden;border-collapse:separate;box-shadow:0 18px 45px rgba(15,23,42,.08);">
            <tr>
              <td style="padding:34px 34px 26px;background:linear-gradient(135deg,#e6fbff 0%,#f2edff 52%,#fff7ed 100%);">
                <img src="${LOGO_URL}" width="136" alt="Sophia AI" style="display:block;width:136px;max-width:60%;height:auto;margin:0 0 22px;">
                <div style="font-size:13px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#5b21b6;">Sophia AI Community</div>
                <h1 style="margin:12px 0 0;color:#06122f;font-size:34px;line-height:1.12;">Welcome, ${escapeHtml(
                  firstName,
                )}.</h1>
                <p style="margin:14px 0 0;color:#334155;font-size:16px;line-height:1.65;">Thank you for joining the Sophia AI community.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 34px;color:#334155;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.7;">We are glad to have you here. From time to time, we will send you useful AI news, practical ideas, product updates, and interesting things that can help you use AI with more confidence in your business.</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.7;">Our goal is to keep it helpful, simple, and worth opening. No noise.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;border-collapse:collapse;">
                  <tr>
                    <td style="padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#f8fbff;">
                      <div style="font-weight:800;color:#0f172a;font-size:16px;margin-bottom:8px;">What you can expect</div>
                      <div style="color:#475569;font-size:15px;line-height:1.65;">AI tips, community updates, useful resources, and selected Sophia AI news.</div>
                    </td>
                  </tr>
                </table>
                <div style="margin-top:26px;">
                  <a href="${escapeHtml(
                    dashboardUrl,
                  )}" style="display:inline-block;background:linear-gradient(90deg,#23c8d2,#7047f7);color:#ffffff;text-decoration:none;border-radius:12px;padding:14px 22px;font-weight:800;font-size:15px;">
                    Explore Sophia AI
                  </a>
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px 34px 30px;border-top:1px solid #e2e8f0;background:#fbfdff;">
                <p style="margin:0 0 10px;color:#64748b;font-size:12px;line-height:1.5;">You are receiving this because you created a Sophia AI account.</p>
                <p style="margin:0;color:#64748b;font-size:12px;line-height:1.5;">If you do not want to receive these emails, <a href="${escapeHtml(
                  unsubscribeUrl,
                )}" style="color:#4f46e5;text-decoration:underline;">unsubscribe here</a>.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function internalCopyRecipients({ to }) {
  const raw =
    process.env.COMMUNITY_EMAIL_BCC ||
    process.env.COMMUNITY_EMAIL_COPY_TO ||
    DEFAULT_INTERNAL_COPY;
  const recipient = String(to || "")
    .trim()
    .toLowerCase();

  return String(raw || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .filter((email) => email.toLowerCase() !== recipient);
}

async function sendViaSES({ from, to, subject, html, user }) {
  const region = process.env.AWS_REGION || "ap-southeast-2";
  const client = new SESv2Client({ region });
  const bcc = internalCopyRecipients({ to });

  await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: {
        ToAddresses: [to],
        ...(bcc.length ? { BccAddresses: bcc } : {}),
      },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Html: { Data: html, Charset: "UTF-8" } },
          Headers: [
            {
              Name: "List-Unsubscribe",
              Value: `<${unsubscribeUrlFor(user)}>`,
            },
          ],
        },
      },
    }),
  );
}

async function sendViaSMTP({ from, to, subject, html, user }) {
  const transport = nodemailer.createTransport({
    host: requireEnv("SMTP_HOST"),
    port: Number(requireEnv("SMTP_PORT")),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  const bcc = internalCopyRecipients({ to });
  await transport.sendMail({
    from,
    to,
    subject,
    html,
    bcc,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrlFor(user)}>`,
    },
  });
}

export async function sendCommunityWelcomeEmail(user) {
  if (!user?.email) throw new Error("user.email is required");
  if (user.emailSubscriptionStatus === "N")
    return { sent: false, reason: "unsubscribed" };

  const provider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();
  const from = process.env.COMMUNITY_EMAIL_FROM || DEFAULT_FROM;
  const subject = "Welcome to the Sophia AI Community";
  const html = buildWelcomeCommunityHtml({ user });

  if (provider === "log") {
    console.log("[community-email][LOG] To:", user.email);
    console.log("[community-email][LOG] Subject:", subject);
    console.log("[community-email][LOG] Unsubscribe:", unsubscribeUrlFor(user));
    return { sent: true, provider };
  }

  if (provider === "smtp") {
    await sendViaSMTP({ from, to: user.email, subject, html, user });
    return { sent: true, provider };
  }

  await sendViaSES({ from, to: user.email, subject, html, user });
  return { sent: true, provider };
}
