import { sendContactEmail } from "../services/contactEmail.service.js";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

export async function submitContact(req, res, next) {
  try {
    const payload = req.body || {};
    const name = String(payload.name || "").trim();
    const email = String(payload.email || "").trim();
    const company = String(payload.company || "").trim();
    const message = String(payload.message || "").trim();

    if (!name || !email || !message) {
      return res.status(400).json({
        error: "Name, email, and message are required",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    if (message.length > 2000) {
      return res.status(400).json({ error: "Message is too long" });
    }

    await sendContactEmail({ name, email, company, message });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}
