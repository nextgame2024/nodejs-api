import { schema as s } from "./reply-store.js";
export async function recordAccepted(db, tenant, m, providerId) {
  await db.query(
    `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,actor_identity,kind,body,metadata,request_key,request_hash) VALUES($1,$2,$3,'outbound_message',$4,$5::jsonb,$6,$7) ON CONFLICT DO NOTHING`,
    [
      tenant,
      m.conversation_id,
      m.actor_identity,
      m.body,
      JSON.stringify({
        channel: "whatsapp",
        origin: m.job_id ? "sophia" : "team",
        messageId: providerId,
        outboxId: m.message_id,
        messageType: m.format ?? "text",
      }),
      m.message_id,
      m.request_hash,
    ],
  );
}
export async function reconcileDelivery(db, profile, channel, event) {
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.assistant_message_outbox') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    return;
  const callback =
    typeof event.callbackId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      event.callbackId,
    )
      ? event.callbackId
      : null;
  const m = (
    await db.query(
      `SELECT * FROM ${s}.assistant_message_outbox WHERE customer_id=$1 AND channel_id=$2 AND (provider_message_id=$3 OR (message_id=$4::uuid AND state IN ('dispatching','unknown','accepted','delivered','read'))) FOR UPDATE`,
      [profile.customerId, channel.channel_id, event.messageId, callback],
    )
  ).rows[0];
  if (!m) return;
  if (m.provider_message_id && m.provider_message_id !== event.messageId)
    return;
  const rank = {
    dispatching: 0,
    unknown: 0,
    accepted: 1,
    failed: 1,
    delivered: 2,
    read: 3,
  };
  const target = {
    sent: "accepted",
    delivered: "delivered",
    read: "read",
    failed: "failed",
  }[event.status];
  if (
    !target ||
    rank[m.state] === undefined ||
    rank[target] < rank[m.state] ||
    (m.state === "failed" && target === "accepted")
  )
    return;
  await db.query(
    `UPDATE ${s}.assistant_message_outbox SET state=$3,provider_message_id=$4,safe_code=$5,updated_at=now() WHERE customer_id=$1 AND message_id=$2`,
    [
      profile.customerId,
      m.message_id,
      target,
      event.messageId,
      target === "failed" ? "delivery_failed" : null,
    ],
  );
  if (target !== "failed")
    await recordAccepted(db, profile.customerId, m, event.messageId);
}
