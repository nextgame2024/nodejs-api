import { createHmac, timingSafeEqual, createHash } from "node:crypto";
const bad = () =>
  Object.assign(new Error("Invalid webhook payload."), { status: 400 });
export function verifySignature(body, signature, secret) {
  if (
    !Buffer.isBuffer(body) ||
    typeof signature !== "string" ||
    !/^sha256=[a-f0-9]{64}$/.test(signature) ||
    !secret
  )
    return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export function verifyToken(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string" || !expected)
    return false;
  const hash = (v) => createHash("sha256").update(v).digest();
  return timingSafeEqual(hash(value), hash(expected));
}
const str = (v, max) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f]/.test(v);
const array = (v) => {
  if (!Array.isArray(v) || v.length > 100) throw bad();
  return v;
};
// Provider payloads become a bounded, provider-neutral receive ledger. Never store
// media URLs, tokens, raw headers, full payloads or unsupported attachment bytes.
export function normalizePayload(body, profile, now = Date.now()) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw bad();
  }
  if (payload?.object !== "whatsapp_business_account") throw bad();
  const result = [];
  const timestamp = (v) => {
    if (typeof v !== "string" || !/^\d{1,12}$/.test(v)) throw bad();
    const ms = Number(v) * 1000;
    if (ms < 946684800000 || ms > now + 300000) throw bad();
    return new Date(ms).toISOString();
  };
  for (const entry of array(payload.entry)) {
    if (entry.id !== profile.businessAccountId) throw bad();
    for (const change of array(entry.changes)) {
      const v = change.value;
      if (!["messages", "smb_message_echoes"].includes(change.field)) {
        result.push({
          key:
            "unsupported:" +
            createHash("sha256").update(JSON.stringify(change)).digest("hex"),
          kind: "unsupported",
          field: String(change.field ?? "unknown").slice(0, 80),
        });
        continue;
      }
      if (
        v?.messaging_product !== "whatsapp" ||
        v?.metadata?.phone_number_id !== profile.phoneNumberId
      )
        throw bad();
      const echo = change.field === "smb_message_echoes";
      for (const message of array(
        (echo ? v.message_echoes : v.messages) ?? [],
      )) {
        const sender = echo ? message.to : message.from;
        if (
          !str(message.id, 300) ||
          typeof sender !== "string" ||
          !/^\d{7,20}$/.test(sender) ||
          !str(message.type, 40)
        )
          throw bad();
        const sentAt = timestamp(message.timestamp);
        const isText = message.type === "text";
        if (
          isText &&
          (typeof message.text?.body !== "string" ||
            message.text.body.length > 16384)
        )
          throw bad();
        const name = (v.contacts ?? []).find?.((c) => c?.wa_id === sender)
          ?.profile?.name;
        result.push({
          key: (echo ? "echo:" : "message:") + message.id,
          kind: echo ? "app_echo" : "inbound",
          messageId: message.id,
          senderId: sender,
          sentAt,
          messageType: message.type,
          body: isText
            ? message.text.body.replace(/\u0000/g, "").slice(0, 4000)
            : "",
          truncated: isText && message.text.body.length > 4000,
          ...(["audio", "image", "video", "document", "sticker"].includes(
            message.type,
          ) && /^[A-Za-z0-9_-]{1,200}$/.test(message[message.type]?.id ?? "")
            ? {
                media: {
                  id: message[message.type].id,
                  mimeType:
                    typeof message[message.type].mime_type === "string" &&
                    /^[a-z0-9.+/-]{1,100}$/i.test(
                      message[message.type].mime_type,
                    )
                      ? message[message.type].mime_type
                      : null,
                  voice:
                    message.type === "audio" && message.audio.voice === true,
                },
              }
            : {}),
          displayName:
            typeof name === "string"
              ? name
                  .replace(/[\u0000-\u001f]/g, "")
                  .trim()
                  .slice(0, 160)
              : "",
        });
      }
      for (const status of array(v.statuses ?? [])) {
        if (
          !str(status.id, 300) ||
          !["sent", "delivered", "read", "failed"].includes(status.status)
        )
          throw bad();
        const sentAt = timestamp(status.timestamp);
        result.push({
          key: `status:${status.id}:${status.status}:${status.timestamp}`,
          kind: "delivery",
          callbackId:
            typeof status.biz_opaque_callback_data === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              status.biz_opaque_callback_data,
            )
              ? status.biz_opaque_callback_data
              : null,
          messageId: status.id,
          status: status.status,
          sentAt,
        });
      }
      if (result.length > 100) throw bad();
    }
  }
  if (result.length > 100) throw bad();
  return result;
}
