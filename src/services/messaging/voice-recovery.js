import { canDispatch } from "./reply-store.js";
const s = "sophia_runtime";
const latestSql = `SELECT * FROM ${s}.assistant_lead_events WHERE customer_id=$1 AND conversation_id=$2 AND kind='inbound_message' ORDER BY COALESCE((metadata->>'sentAt')::timestamptz,created_at) DESC,COALESCE((metadata->>'transcriptOf')::bigint,event_id) DESC,event_id DESC LIMIT 1`;
export async function failJob(db, profile, job, state, code) {
  await db.query(
    `UPDATE ${s}.assistant_voice_jobs SET state=$3,failure_code=$4,completed_at=now() WHERE customer_id=$1 AND voice_job_id=$2`,
    [profile.customerId, job.voice_job_id, state, code],
  );
  if (job.kind === "synthesize")
    await db.query(
      `UPDATE ${s}.assistant_message_outbox SET state=$3,safe_code=$4,updated_at=now() WHERE customer_id=$1 AND message_id=$2 AND state IN ('preparing','queued')`,
      [
        profile.customerId,
        job.message_id,
        state === "cancelled" ? "cancelled" : "failed",
        code,
      ],
    );
  else {
    const latest = (
      await db.query(latestSql, [profile.customerId, job.conversation_id])
    ).rows[0];
    if (latest?.event_id === job.source_event_id) {
      const c = (
        await db.query(
          `SELECT ownership_version FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND conversation_id=$2 AND ownership='bot' AND ownership_version=$3`,
          [profile.customerId, job.conversation_id, job.ownership_version],
        )
      ).rows[0];
      if (
        c &&
        state === "failed" &&
        canDispatch(profile) &&
        process.env.WHATSAPP_AUTOMATION_ENABLED === "true"
      ) {
        const lang = (
          await db.query(
            `SELECT language FROM ${s}.assistant_leads WHERE customer_id=$1 AND lead_id=$2`,
            [profile.customerId, job.lead_id],
          )
        ).rows[0].language;
        const body =
          {
            es: "Lo siento, no puedo procesar el audio ahora. Por favor, escribe tu pregunta y seguimos por aquí.",
            pt: "Desculpe, não consigo processar o áudio agora. Escreva sua pergunta e continuamos por aqui.",
            en: "Sorry, I can't process that voice message right now. Please type your question and we can keep chatting here.",
          }[lang] ??
          "Sorry, I can't process that voice message right now. Please type your question and we can keep chatting here.";
        await db.query(
          `INSERT INTO ${s}.assistant_message_outbox(customer_id,channel_id,lead_id,conversation_id,ownership_version,body,request_key,request_hash,voice_failure_job_id) VALUES($1,$2,$3,$4,$5,$6,$7,'voice_failure',$7) ON CONFLICT DO NOTHING`,
          [
            profile.customerId,
            job.channel_id,
            job.lead_id,
            job.conversation_id,
            c.ownership_version,
            body,
            job.voice_job_id,
          ],
        );
      }
    }
  }
}
