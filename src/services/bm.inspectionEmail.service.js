import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function emailHtml(booking) {
  const address = [
    booking.propertyAddress,
    booking.propertySuburb,
    booking.propertyCity,
    booking.propertyState,
    booking.propertyPostcode,
  ].filter(Boolean).join(", ");

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#17202a;max-width:620px;margin:auto">
      <h2 style="color:#0f766e">Your property inspection is confirmed</h2>
      <p>Hi ${escapeHtml(booking.customerName)},</p>
      <p>Your inspection booking is all set.</p>
      <table style="border-collapse:collapse;width:100%;margin:20px 0">
        <tr><td style="padding:8px 0;color:#64748b">Property</td><td style="padding:8px 0;font-weight:700">${escapeHtml(address)}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Date and time</td><td style="padding:8px 0;font-weight:700">${escapeHtml(booking.startsAtLabel)}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b">Reference</td><td style="padding:8px 0;font-weight:700">${escapeHtml(String(booking.bookingId).slice(0, 8).toUpperCase())}</td></tr>
      </table>
      <p>Please arrive a few minutes early and contact the agency if your plans change.</p>
      <p style="color:#64748b;font-size:12px">This confirmation was sent by Sophia AI for the agency demonstration.</p>
    </div>`;
}

export async function sendInspectionConfirmationEmail(booking) {
  const provider = (process.env.EMAIL_PROVIDER || "ses").toLowerCase();
  const subject = `Inspection confirmed: ${booking.propertyAddress}`;
  const html = emailHtml(booking);

  if (provider === "log") {
    console.log("[inspection-email][LOG] To:", booking.customerEmail);
    console.log("[inspection-email][LOG] Subject:", subject);
    console.log("[inspection-email][LOG] Time:", booking.startsAtLabel);
    return;
  }

  if (provider === "smtp") {
    const transport = nodemailer.createTransport({
      host: requireEnv("SMTP_HOST"),
      port: Number(requireEnv("SMTP_PORT")),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail({
      from: requireEnv("SMTP_FROM_EMAIL"),
      to: booking.customerEmail,
      subject,
      html,
    });
    return;
  }

  const client = new SESv2Client({
    region: process.env.AWS_REGION || "ap-southeast-2",
  });
  await client.send(new SendEmailCommand({
    FromEmailAddress: requireEnv("SES_FROM_EMAIL"),
    Destination: { ToAddresses: [booking.customerEmail] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Html: { Data: html, Charset: "UTF-8" } },
      },
    },
  }));
}
