import { randomUUID } from "node:crypto";
import { contactDetails } from "./customer-preferences.js";
import { canDispatch, currentRelease } from "./reply-store.js";
import { queueVoicePair } from "./voice-store.js";
const s = "sophia_runtime";
export async function acknowledgeContact(
  db,
  profile,
  channel,
  lead,
  conversation,
  body,
  eventId,
  isNew = false,
) {
  const details = contactDetails(body);
  if (
    !details ||
    (details.name && details.name !== lead.display_name) ||
    (details.email && details.email !== lead.email) ||
    lead.stage === "closed" ||
    !canDispatch(profile) ||
    process.env.WHATSAPP_AUTOMATION_ENABLED !== "true"
  )
    return false;
  const binding = (
    await db.query(
      `SELECT * FROM ${s}.assistant_reply_bindings WHERE customer_id=$1 AND channel_id=$2`,
      [profile.customerId, channel.channel_id],
    )
  ).rows[0];
  if (binding?.mode !== "automatic") return false;
  await currentRelease(db, profile.customerId, binding.agent_release_id);
  if (isNew && conversation.ownership === "human_requested") {
    const c = (
      await db.query(
        `UPDATE ${s}.assistant_lead_conversations SET ownership='bot',ownership_version=ownership_version+1 WHERE customer_id=$1 AND conversation_id=$2 AND ownership='human_requested' AND ownership_version=$3 RETURNING ownership_version`,
        [
          profile.customerId,
          conversation.conversation_id,
          conversation.ownership_version,
        ],
      )
    ).rows[0];
    if (!c) return false;
    conversation.ownership = "bot";
    conversation.ownership_version = c.ownership_version;
  }
  if (conversation.ownership !== "bot") return false;
  const lang = String(lead.language || "en").split("-")[0];
  const reply =
    {
      en: "Thanks! I've saved your details. How else can I help you?",
      es: "¡Gracias! Ya guardé tus datos. ¿En qué más puedo ayudarte?",
      pt: "Obrigado! Salvei seus dados. Em que mais posso ajudar?",
    }[lang] || "Thanks! I've saved your details. How else can I help you?";
  const id = randomUUID();
  await db.query(
    `INSERT INTO ${s}.assistant_message_outbox(message_id,customer_id,channel_id,lead_id,conversation_id,ownership_version,body,request_key,request_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8)`,
    [
      id,
      profile.customerId,
      channel.channel_id,
      lead.lead_id,
      conversation.conversation_id,
      conversation.ownership_version,
      reply,
      `contact_ack:${eventId}:${binding.revision}`,
    ],
  );
  await queueVoicePair(db, profile.customerId, id);
  return true;
}
