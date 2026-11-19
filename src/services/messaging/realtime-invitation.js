// Deployment-owned public destination only. No customer identity or transcript
// goes into the link. Offered once, even if the reply is ignored or declined.
export function publicRealtimeUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/sophia"
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
export async function realtimeInvitationState(
  db,
  tenant,
  conversationId,
  sourceEventId,
  url,
) {
  if (!publicRealtimeUrl(url)) return { eligible: false };
  const row = (
    await db.query(
      `SELECT
    (SELECT count(*)::int FROM sophia_runtime.assistant_lead_events
      WHERE customer_id=$1 AND conversation_id=$2 AND event_id<=$3
      AND kind='inbound_message' AND metadata->>'messageType'='text'
      AND COALESCE(metadata->>'truncated','false')<>'true'
      AND (body ~ '[?¿]' OR lower(body) ~ '(^|[.!] *)(what|how|why|where|when|can you|could you|tell me|explain|cuánto|cuanto|cómo|como|qué|que|dónde|donde|puedes|me gustaría saber|gostaria de saber|pode)\\M')) AS questions,
    EXISTS(SELECT 1 FROM sophia_runtime.assistant_reply_jobs WHERE customer_id=$1 AND conversation_id=$2
      AND usage->'engagement'->>'realtimeOffered'='true') AS offered`,
      [tenant, conversationId, sourceEventId],
    )
  ).rows[0];
  return { eligible: row?.questions >= 3 && !row?.offered };
}
export function invitationCopy(language, url) {
  const code = String(language || "en")
    .split("-")[0]
    .toLowerCase();
  if (code === "es")
    return `Si prefieres hablar por voz con Sophia, puedes continuar aquí: ${url}. También podemos seguir por WhatsApp; tú eliges.`;
  if (code === "pt")
    return `Se preferir conversar por voz com a Sophia, você pode continuar aqui: ${url}. Também podemos seguir pelo WhatsApp; você escolhe.`;
  return `If you prefer to talk with Sophia by voice, you can continue here: ${url}. We can also keep chatting on WhatsApp—it's your choice.`;
}
