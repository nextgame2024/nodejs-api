import { discoveryInstalled } from "../leads/lead-discovery.service.js";
const s = "sophia_runtime";
export const followUpEnabled = (profile) =>
  profile.qualificationEnabled === true &&
  profile.followUpEnabled === true &&
  process.env.WHATSAPP_AUTOMATION_ENABLED === "true";
// A literal command is explicit consent for ONE reminder, never model-inferred consent.
export const followUpConsent = (text) =>
  typeof text === "string" && text.trim().toUpperCase() === "FOLLOW UP";
export async function recordFollowUpConsent(
  db,
  profile,
  channel,
  lead,
  conversation,
  eventId,
  event,
) {
  if (!(await discoveryInstalled(db))) return;
  await db.query(
    `UPDATE ${s}.assistant_follow_up_requests SET state='cancelled' WHERE customer_id=$1 AND lead_id=$2 AND state IN ('scheduled','queued')`,
    [profile.customerId, lead.lead_id],
  );
  await db.query(
    `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='newer_message',updated_at=now() WHERE customer_id=$1 AND lead_id=$2 AND follow_up_request_id IS NOT NULL AND state='queued'`,
    [profile.customerId, lead.lead_id],
  );
  if (
    !followUpEnabled(profile) ||
    event.messageType !== "text" ||
    event.truncated ||
    !followUpConsent(event.body) ||
    conversation.ownership !== "bot" ||
    lead.stage === "closed"
  )
    return;
  await db.query(
    `INSERT INTO ${s}.assistant_follow_up_requests(customer_id,lead_id,conversation_id,channel_id,consent_event_id,ownership_version)
    SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS(SELECT 1 FROM ${s}.assistant_channel_contacts WHERE customer_id=$1 AND lead_id=$2 AND opted_out)
    ON CONFLICT DO NOTHING`,
    [
      profile.customerId,
      lead.lead_id,
      conversation.conversation_id,
      channel.channel_id,
      eventId,
      conversation.ownership_version,
    ],
  );
}
export const followUpCopy = (language) =>
  ({
    en: "As requested, here is your one follow-up. Would you like to continue discussing your business needs or arrange a discovery appointment? Reply STOP to stop automated messages.",
    es: "Como solicitaste, este es tu único seguimiento. ¿Quieres continuar hablando de las necesidades de tu negocio o concertar una cita? Responde STOP para detener los mensajes automáticos.",
    pt: "Conforme solicitado, este é seu único acompanhamento. Gostaria de continuar falando sobre as necessidades do seu negócio ou agendar uma reunião? Responda STOP para parar as mensagens automáticas.",
  })[language] ??
  "As requested, here is your one follow-up. Would you like to continue or arrange a discovery appointment? Reply STOP to stop automated messages.";
