import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  claimDueToolkitEmails,
  claimToolkitEmailByPaymentAndKey,
  createToolkitEmailScheduleRows,
  getToolkitPaymentEmailContext,
  markToolkitEmailFailed,
  markToolkitEmailSent,
} from "../models/aiToolkitEmailSchedule.model.js";

const LOGO_URL =
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/company-logos/1776856137438-cjet9pj1u6u.png";
const DEFAULT_FROM = "Sophia AI <hello@sophiaai.com.au>";
const PRODUCT_URL = "/manager/dashboard";

const EMAILS = [
  {
    key: "welcome",
    dayOffset: 0,
    subject: "Welcome! Your Sophia AI Toolkit is ready",
    previewText:
      "Your toolkit is ready. Complete your first AI task in less than 5 minutes.",
    ctaLabel: "Login to Sophia AI",
    ctaPath: PRODUCT_URL,
    title: "Welcome to Sophia AI.",
    intro: [
      "Thank you for joining us.",
      "Our mission is simple: help small business owners save time using AI without becoming AI experts.",
      "Your toolkit is now ready.",
    ],
    sections: [
      {
        heading: "Start here",
        body: [
          "If this is your first time using AI, do not worry.",
          "We have created a simple Start Here Guide that will help you complete your first business task in just a few minutes.",
        ],
      },
      {
        heading: "I recommend starting with:",
        items: [
          {
            title: "Reply to a Customer Enquiry",
            description:
              "You will see how AI can draft a professional reply in minutes.",
          },
        ],
      },
      {
        heading: "Here is a small challenge:",
        body: [
          "Complete one recipe today.",
          "That is it. Do not try to learn everything.",
          "Just experience your first win.",
          "See you inside.",
        ],
      },
    ],
  },
  {
    key: "day-2-recipes",
    dayOffset: 2,
    subject: "5 recipes every small business owner should use this week",
    previewText: "Save hours this week with these customer favourites.",
    ctaLabel: "Open Sophia AI",
    ctaPath: PRODUCT_URL,
    title: "5 recipes to try this week",
    intro: [
      "Yesterday you joined Sophia AI.",
      "Today I would like to show you the five recipes that almost every business owner uses.",
    ],
    sections: [
      {
        items: [
          {
            title: "Reply to a Customer Enquiry",
            description: "Respond professionally in minutes.",
          },
          {
            title: "Write a Quote",
            description: "Create clear, customer-friendly quotations.",
          },
          {
            title: "Create a Facebook Post",
            description: "Never wonder what to post again.",
          },
          {
            title: "Write an SOP",
            description: "Document your business processes quickly.",
          },
          {
            title: "Invoice Reminder",
            description:
              "Send polite payment reminders without awkward wording.",
          },
        ],
      },
      {
        body: [
          "These five recipes alone can save you several hours every week.",
          "Talk soon.",
        ],
      },
    ],
  },
  {
    key: "day-5-workflows",
    dayOffset: 5,
    subject: "Most people do not realize these recipes work together",
    previewText: "Stop copying prompts. Start using workflows.",
    ctaLabel: "Explore more workflows",
    ctaPath: PRODUCT_URL,
    title: "Recipes become more powerful together",
    intro: [
      "Here is a secret.",
      "The real power of Sophia AI is not the individual recipes.",
      "It is the workflows.",
      "Here is an example.",
    ],
    sections: [
      {
        heading: "Customer Quote Workflow",
        steps: [
          "Customer sends an enquiry.",
          "Use Reply to Customer Enquiry.",
          "Prepare the quotation.",
          "Use Write a Quote.",
          "Send the quotation.",
          "No reply? Use Follow-up Email.",
          "Customer accepts. Done.",
        ],
      },
      {
        body: [
          "Instead of saving ten minutes, you have just saved nearly an hour.",
          "That is why we designed Sophia AI around real business workflows, not just prompts.",
        ],
      },
    ],
  },
  {
    key: "day-10-hidden-gems",
    dayOffset: 10,
    subject: "Most users never discover these hidden gems...",
    previewText: "These recipes quietly save hours every month.",
    ctaLabel: "Explore hidden gems",
    ctaPath: PRODUCT_URL,
    title: "A few hidden gems",
    intro: [
      "Some of the most valuable recipes are not the most popular.",
      "Here are a few hidden gems.",
    ],
    sections: [
      {
        items: [
          {
            title: "Summarise Meeting Notes",
            description: "Never write meeting minutes manually again.",
          },
          {
            title: "Rewrite Website Copy",
            description: "Improve your website in minutes.",
          },
          {
            title: "Job Description Generator",
            description: "Perfect for hiring.",
          },
          {
            title: "Google Review Response",
            description: "Protect your online reputation.",
          },
          {
            title: "Weekly Planner",
            description: "Plan your week in minutes.",
          },
        ],
      },
      {
        body: [
          "Try one you have never opened before.",
          "You might discover your new favourite.",
        ],
      },
    ],
  },
  {
    key: "day-20-updates",
    dayOffset: 20,
    subject: "New recipes are waiting for you",
    previewText: "We have added new content to help your business.",
    ctaLabel: "See what is new",
    ctaPath: PRODUCT_URL,
    title: "Sophia AI keeps growing",
    intro: [
      "We have recently added new recipes to help small business owners save even more time.",
    ],
    sections: [
      {
        heading: "New this month",
        items: [
          { title: "Create a Marketing Campaign" },
          { title: "Business Decision Summary" },
          { title: "Team Announcement" },
          { title: "Training Instructions" },
          { title: "Product Comparison" },
        ],
      },
      {
        body: [
          "Remember, your purchase includes lifetime updates.",
          "Every new recipe becomes available automatically.",
          "So it is worth checking back regularly.",
          "Thank you for being one of our early customers.",
          "We are just getting started.",
        ],
      },
    ],
  },
  {
    key: "day-30-feedback",
    dayOffset: 30,
    subject: "Can I ask you one question?",
    previewText:
      "Your feedback helps shape future Sophia AI toolkit recipes.",
    ctaLabel: "Open Sophia AI",
    ctaPath: PRODUCT_URL,
    title: "Can I ask one question?",
    intro: [
      "You have been using Sophia AI for about a month.",
      "I would love to know:",
      "What is the ONE recipe you wish existed?",
      "Reply to this email. Even one sentence helps.",
      "Many of our future recipes will come directly from customer suggestions.",
      "Thanks for helping shape Sophia AI.",
    ],
    sections: [],
  },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function clientUrl(path = PRODUCT_URL) {
  const base = String(process.env.CLIENT_URL || "https://sophiaai.com.au")
    .replace(/\/+$/, "");
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

function addDays(date, days) {
  const value = date ? new Date(date) : new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function findEmailDefinition(emailKey) {
  return EMAILS.find((email) => email.key === emailKey) || null;
}

function sectionHtml(section) {
  const body = (section.body || [])
    .map(
      (line) =>
        `<p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.65;">${escapeHtml(
          line,
        )}</p>`,
    )
    .join("");

  const items = (section.items || [])
    .map(
      (item) => `
        <tr>
          <td style="padding:16px 0;border-top:1px solid #e2e8f0;">
            <div style="font-weight:800;color:#0f172a;font-size:16px;">${escapeHtml(
              item.title,
            )}</div>
            ${
              item.description
                ? `<div style="margin-top:6px;color:#475569;font-size:14px;line-height:1.55;">${escapeHtml(
                    item.description,
                  )}</div>`
                : ""
            }
          </td>
        </tr>`,
    )
    .join("");

  const steps = (section.steps || [])
    .map(
      (step, index) => `
        <tr>
          <td style="padding:10px 0;">
            <span style="display:inline-block;width:28px;height:28px;border-radius:999px;background:#eef2ff;color:#4f46e5;text-align:center;line-height:28px;font-weight:800;font-size:13px;margin-right:10px;">${
              index + 1
            }</span>
            <span style="color:#334155;font-size:15px;line-height:1.55;">${escapeHtml(
              step,
            )}</span>
          </td>
        </tr>`,
    )
    .join("");

  return `
    <div style="margin-top:22px;">
      ${
        section.heading
          ? `<h3 style="margin:0 0 12px;color:#0f172a;font-size:17px;line-height:1.35;">${escapeHtml(
              section.heading,
            )}</h3>`
          : ""
      }
      ${body}
      ${
        items
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${items}</table>`
          : ""
      }
      ${
        steps
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${steps}</table>`
          : ""
      }
    </div>`;
}

function buildEmailHtml({ definition, firstName }) {
  const previewText = escapeHtml(definition.previewText);
  const intro = (definition.intro || [])
    .map((line, index) => {
      const isQuestion =
        definition.key === "day-30-feedback" &&
        line.toLowerCase().startsWith("what is the one");
      return `<p style="margin:0 0 14px;color:${
        isQuestion ? "#111827" : "#334155"
      };font-size:${isQuestion ? "18px" : "15px"};font-weight:${
        isQuestion ? "800" : "400"
      };line-height:1.65;">${
        index === 0 ? `Hi ${escapeHtml(firstName)}, ` : ""
      }${escapeHtml(line)}</p>`;
    })
    .join("");
  const sections = (definition.sections || []).map(sectionHtml).join("");
  const ctaUrl = clientUrl(definition.ctaPath);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(definition.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef4ff;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${previewText}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4ff;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:28px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #dbe4f0;border-radius:18px;overflow:hidden;border-collapse:separate;">
            <tr>
              <td style="padding:28px 30px 18px;background:linear-gradient(135deg,#eefbff 0%,#f5f3ff 100%);">
                <div style="font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5;">Sophia AI Toolkit</div>
                <h1 style="margin:12px 0 0;color:#07112b;font-size:30px;line-height:1.15;">${escapeHtml(
                  definition.title,
                )}</h1>
                <p style="margin:12px 0 0;color:#475569;font-size:15px;line-height:1.6;">${previewText}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 30px;color:#334155;">
                ${intro}
                ${sections}
                <div style="margin-top:26px;">
                  <a href="${escapeHtml(
                    ctaUrl,
                  )}" style="display:inline-block;background:linear-gradient(90deg,#27c7d9,#7047f7);color:#ffffff;text-decoration:none;border-radius:10px;padding:13px 20px;font-weight:800;font-size:15px;">
                    ${escapeHtml(definition.ctaLabel)}
                  </a>
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px 30px 30px;border-top:1px solid #e2e8f0;background:#fbfdff;">
                <img src="${LOGO_URL}" width="124" alt="Sophia AI" style="display:block;width:124px;max-width:60%;height:auto;margin:0 auto 10px;">
                <p style="margin:0;color:#64748b;font-size:12px;line-height:1.5;">You are receiving this because you purchased the Sophia AI Business Toolkit.</p>
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

async function sendToolkitEmail(row) {
  const definition = findEmailDefinition(row.email_key);
  if (!definition) throw new Error(`Unknown toolkit email key: ${row.email_key}`);

  const provider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();
  const from = process.env.AI_TOOLKIT_EMAIL_FROM || DEFAULT_FROM;
  const firstName = firstNameFrom({
    name: row.recipient_name,
    username: row.recipient_name,
    email: row.recipient_email,
  });
  const html = buildEmailHtml({ definition, firstName });

  if (provider === "log") {
    console.log("[toolkit-email][LOG] To:", row.recipient_email);
    console.log("[toolkit-email][LOG] Subject:", definition.subject);
    console.log("[toolkit-email][LOG] Key:", row.email_key);
    return;
  }

  if (provider === "smtp") {
    await sendViaSMTP({
      from,
      to: row.recipient_email,
      subject: definition.subject,
      html,
    });
    return;
  }

  await sendViaSES({
    from,
    to: row.recipient_email,
    subject: definition.subject,
    html,
  });
}

export async function sendToolkitEmailPreview({
  toEmail,
  emailKey,
  recipientName = "Jose",
}) {
  if (!toEmail) throw new Error("toEmail is required");
  const definition = findEmailDefinition(emailKey);
  if (!definition) throw new Error(`Unknown toolkit email key: ${emailKey}`);

  await sendToolkitEmail({
    email_key: emailKey,
    recipient_email: toEmail,
    recipient_name: recipientName,
  });
}

export async function scheduleToolkitPurchaseEmails(paymentId) {
  const context = await getToolkitPaymentEmailContext(paymentId);
  if (!context?.email) {
    throw new Error(`Toolkit payment email context not found: ${paymentId}`);
  }

  const recipientName = firstNameFrom(context);
  const paidAt = context.paidAt || new Date();
  const rows = EMAILS.map((definition) => ({
    paymentId: context.paymentId,
    userId: context.userId,
    emailKey: definition.key,
    dayOffset: definition.dayOffset,
    recipientEmail: context.email,
    recipientName,
    subject: definition.subject,
    previewText: definition.previewText,
    scheduledFor: addDays(paidAt, definition.dayOffset),
  }));

  return createToolkitEmailScheduleRows(rows);
}

export async function sendImmediateToolkitWelcomeEmail(paymentId) {
  const row = await claimToolkitEmailByPaymentAndKey({
    paymentId,
    emailKey: "welcome",
  });

  if (!row) return { sent: false, reason: "not_due_or_already_sent" };

  try {
    await sendToolkitEmail(row);
    await markToolkitEmailSent(row.id);
    return { sent: true };
  } catch (error) {
    await markToolkitEmailFailed(row.id, error?.message || error);
    throw error;
  }
}

export async function processDueToolkitEmails({ limit = 25 } = {}) {
  const rows = await claimDueToolkitEmails({ limit });
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await sendToolkitEmail(row);
      await markToolkitEmailSent(row.id);
      sent += 1;
    } catch (error) {
      await markToolkitEmailFailed(row.id, error?.message || error);
      console.error(
        "[toolkit-email] send failed:",
        row.id,
        row.email_key,
        error?.message || error,
      );
      failed += 1;
    }
  }

  return { claimed: rows.length, sent, failed };
}
