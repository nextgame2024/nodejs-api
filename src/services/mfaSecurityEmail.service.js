import nodemailer from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const DEFAULT_FROM = "Sophia AI <hello@sophiaai.com.au>";

export async function sendMfaDisabledEmail({ user }) {
  if (!user?.email) throw new Error("user.email is required");
  const provider = String(process.env.EMAIL_PROVIDER || "ses").toLowerCase();
  const from = process.env.SECURITY_EMAIL_FROM || process.env.PASSWORD_RESET_EMAIL_FROM || DEFAULT_FROM;
  const message = {
    from,
    to: user.email,
    subject: "Authenticator MFA was disabled on your Sophia AI account",
    html: disabledHtml(user),
  };
  if (provider === "log") {
    console.log("[security-email][LOG] To:", user.email);
    console.log("[security-email][LOG] Subject:", message.subject);
    return { sent: true, provider };
  }
  if (provider === "smtp") {
    const transport = nodemailer.createTransport({
      host: required("SMTP_HOST"),
      port: Number(required("SMTP_PORT")),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail(message);
    return { sent: true, provider };
  }
  const client = new SESv2Client({ region: process.env.AWS_REGION || "ap-southeast-2" });
  await client.send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [user.email] },
    Content: { Simple: {
      Subject: { Data: message.subject, Charset: "UTF-8" },
      Body: { Html: { Data: message.html, Charset: "UTF-8" } },
    } },
  }));
  return { sent: true, provider };
}

function disabledHtml(user) {
  const name = escapeHtml(user.name || user.username || user.email || "there");
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1e293b">
    <h1>Authenticator MFA was disabled</h1>
    <p>Hi ${name},</p>
    <p>Authenticator MFA was disabled on your Sophia AI account. All existing sessions were signed out.</p>
    <p>If you did not make this change, reset your password and contact Sophia AI support immediately.</p>
  </body></html>`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
