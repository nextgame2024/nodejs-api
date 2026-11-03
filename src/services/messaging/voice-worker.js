import { randomUUID } from "node:crypto";
import { scoped, optOut } from "./whatsapp-channel.service.js";
import {
  schema as s,
  canDispatch,
  enqueueAutomatic,
  invalidateOlderReplies,
} from "./reply-store.js";
import { voiceEnabled, voiceInstalled, approveSpeech } from "./voice-store.js";
import { encryptAudio, decryptAudio } from "./audio/crypto.js";
import { decodeAudio, encodeVoice } from "./audio/codec.js";
const latestSql = `SELECT * FROM ${s}.assistant_lead_events WHERE customer_id=$1 AND conversation_id=$2 AND kind='inbound_message' ORDER BY COALESCE((metadata->>'sentAt')::timestamptz,created_at) DESC,COALESCE((metadata->>'transcriptOf')::bigint,event_id) DESC,event_id DESC LIMIT 1`;
async function claim(profile, kind) {
  return scoped(profile, async (db, channel) => {
    if (!(await voiceInstalled(db))) return null;
    const candidate = (
      await db.query(
        `SELECT * FROM ${s}.assistant_voice_jobs WHERE customer_id=$1 AND channel_id=$2 AND kind=$3 AND (state='queued' OR(state='working' AND lease_until<now())) ORDER BY created_at LIMIT 1`,
        [profile.customerId, channel.channel_id, kind],
      )
    ).rows[0];
    if (!candidate) return null;
    const lead = (
      await db.query(
        `SELECT * FROM ${s}.assistant_leads WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
        [profile.customerId, candidate.lead_id],
      )
    ).rows[0];
    const c = (
      await db.query(
        `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND conversation_id=$2 FOR UPDATE`,
        [profile.customerId, candidate.conversation_id],
      )
    ).rows[0];
    const job = (
      await db.query(
        `SELECT * FROM ${s}.assistant_voice_jobs WHERE customer_id=$1 AND voice_job_id=$2 AND(state='queued' OR(state='working' AND lease_until<now())) FOR UPDATE SKIP LOCKED`,
        [profile.customerId, candidate.voice_job_id],
      )
    ).rows[0];
    if (!job) return null;
    const contact = (
      await db.query(
        `SELECT *,last_inbound_at>now()-interval '24 hours' AS window_open FROM ${s}.assistant_channel_contacts WHERE customer_id=$1 AND lead_id=$2`,
        [profile.customerId, lead.lead_id],
      )
    ).rows[0];
    const binding = (
      await db.query(
        `SELECT * FROM ${s}.assistant_reply_bindings WHERE customer_id=$1 AND channel_id=$2`,
        [profile.customerId, channel.channel_id],
      )
    ).rows[0];
    let content;
    if (kind === "transcribe")
      content = (
        await db.query(
          `SELECT * FROM ${s}.assistant_lead_events WHERE customer_id=$1 AND conversation_id=$2 AND event_id=$3`,
          [profile.customerId, c.conversation_id, job.source_event_id],
        )
      ).rows[0];
    else
      content = (
        await db.query(
          `SELECT * FROM ${s}.assistant_message_outbox WHERE customer_id=$1 AND message_id=$2 FOR UPDATE`,
          [profile.customerId, job.message_id],
        )
      ).rows[0];
    const stale =
      lead.stage === "closed" ||
      contact.opted_out ||
      !contact.window_open ||
      binding?.revision !== job.binding_revision ||
      binding?.agent_release_id !== job.agent_release_id ||
      !content ||
      (kind === "synthesize" &&
        (c.ownership_version !== job.ownership_version ||
          content.state !== "preparing"));
    if (stale || job.attempts >= 2) {
      await failJob(
        db,
        profile,
        job,
        stale ? "cancelled" : "failed",
        stale ? "conversation_changed" : "attempt_limit",
      );
      return null;
    }
    let allowed;
    try {
      allowed = await approveSpeech(db, profile.customerId, job, profile);
    } catch (e) {
      if (e.status !== 409) throw e;
      allowed = false;
    }
    if (!allowed) {
      await failJob(db, profile, job, "failed", "configuration_required");
      return null;
    }
    const lease = randomUUID();
    await db.query(
      `UPDATE ${s}.assistant_voice_jobs SET state='working',lease_id=$3,lease_until=now()+interval '3 minutes',attempts=attempts+1 WHERE customer_id=$1 AND voice_job_id=$2`,
      [profile.customerId, job.voice_job_id, lease],
    );
    return { job, lease, content };
  });
}
async function failJob(db, profile, job, state, code) {
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
          `UPDATE ${s}.assistant_lead_conversations SET ownership='human_requested',ownership_version=ownership_version+1 WHERE customer_id=$1 AND conversation_id=$2 AND ownership='bot' AND ownership_version=$3 RETURNING ownership_version`,
          [profile.customerId, job.conversation_id, job.ownership_version],
        )
      ).rows[0];
      if (
        c &&
        code === "voice_transcription_failed" &&
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
            es: "No pude entender el mensaje de voz. Por favor, envíalo de nuevo o escribe tu pregunta. Nuestro equipo también puede ayudarte.",
            pt: "Não consegui entender a mensagem de voz. Envie novamente ou escreva sua pergunta. Nossa equipe também pode ajudar.",
            en: "I could not understand the voice message. Please send it again or type your question. Our team can also help.",
          }[lang] ??
          "I could not understand the voice message. Please send it again or type your question. Our team can also help.";
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
async function finish(profile, task, work) {
  return scoped(
    profile,
    async (db) => {
      const lead = (
        await db.query(
          `SELECT stage FROM ${s}.assistant_leads WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
          [profile.customerId, task.job.lead_id],
        )
      ).rows[0];
      const c = (
        await db.query(
          `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND conversation_id=$2 FOR UPDATE`,
          [profile.customerId, task.job.conversation_id],
        )
      ).rows[0];
      const job = (
        await db.query(
          `SELECT * FROM ${s}.assistant_voice_jobs WHERE customer_id=$1 AND voice_job_id=$2 AND state='working' AND lease_id=$3 AND lease_until>now() FOR UPDATE`,
          [profile.customerId, task.job.voice_job_id, task.lease],
        )
      ).rows[0];
      if (!job) return;
      const contact = (
        await db.query(
          `SELECT opted_out FROM ${s}.assistant_channel_contacts WHERE customer_id=$1 AND lead_id=$2`,
          [profile.customerId, job.lead_id],
        )
      ).rows[0];
      const binding = (
        await db.query(
          `SELECT revision,agent_release_id FROM ${s}.assistant_reply_bindings WHERE customer_id=$1 AND channel_id=$2`,
          [profile.customerId, job.channel_id],
        )
      ).rows[0];
      let allowed = false;
      try {
        allowed = await approveSpeech(db, profile.customerId, job, profile);
      } catch (e) {
        if (e.status !== 409) throw e;
      }
      if (
        lead.stage === "closed" ||
        contact.opted_out ||
        !allowed ||
        binding?.revision !== job.binding_revision ||
        binding?.agent_release_id !== job.agent_release_id ||
        (job.kind === "synthesize" &&
          c.ownership_version !== job.ownership_version)
      ) {
        await failJob(db, profile, job, "cancelled", "conversation_changed");
        return;
      }
      await work(db, job, c);
    },
    { requireEnabled: false },
  );
}
export async function transcribeOne(
  profile,
  { download, transcribe, decode = decodeAudio },
) {
  if (!voiceEnabled(profile)) return { processed: false };
  const task = await claim(profile, "transcribe");
  if (!task) return { processed: false };
  let bytes, pcm;
  try {
    const media = task.content.metadata.media;
    if (task.content.metadata.messageType !== "audio" || !media?.id)
      throw new Error("media");
    const result = await download(profile, media);
    bytes = result.bytes;
    pcm = await decode(bytes, result.mimeType);
    const transcript = await transcribe({
      adapterKey: profile.transcriptionAdapter,
      credentialRef: profile.transcriptionCredentialRef,
      jobId: task.job.voice_job_id,
      pcm,
      signal: AbortSignal.timeout(60000),
    });
    if (
      typeof transcript !== "string" ||
      !transcript.trim() ||
      transcript.length > 4000
    )
      throw new Error("transcript");
    await finish(profile, task, async (db, job, c) => {
      const latest = (
        await db.query(latestSql, [profile.customerId, job.conversation_id])
      ).rows[0];
      const current = latest?.event_id === job.source_event_id;
      const e = (
        await db.query(
          `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,kind,body,metadata,request_key,request_hash) VALUES($1,$2,'inbound_message',$3,$4::jsonb,$5,'voice_transcript') ON CONFLICT DO NOTHING RETURNING event_id`,
          [
            profile.customerId,
            job.conversation_id,
            transcript.trim(),
            JSON.stringify({
              channel: "whatsapp",
              origin: "customer",
              messageType: "text",
              transcriptOf: job.source_event_id,
              sentAt: task.content.metadata.sentAt,
              messageId: task.content.metadata.messageId,
            }),
            job.voice_job_id,
          ],
        )
      ).rows[0];
      if (optOut(transcript)) {
        await db.query(
          `UPDATE ${s}.assistant_channel_contacts SET opted_out=true WHERE customer_id=$1 AND lead_id=$2`,
          [profile.customerId, job.lead_id],
        );
        await db.query(
          `UPDATE ${s}.assistant_lead_conversations SET ownership='paused',human_owner_identity=NULL,ownership_version=ownership_version+1 WHERE customer_id=$1 AND conversation_id=$2`,
          [profile.customerId, job.conversation_id],
        );
      } else if (e && current) {
        await invalidateOlderReplies(
          db,
          profile.customerId,
          job.lead_id,
          e.event_id,
        );
        await enqueueAutomatic(db, profile, job.lead_id, e.event_id, false);
      }
      await db.query(
        `UPDATE ${s}.assistant_leads SET updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
        [profile.customerId, job.lead_id],
      );
      await db.query(
        `UPDATE ${s}.assistant_voice_jobs SET state='ready',transcript_event_id=$3,completed_at=now(),failure_code=NULL WHERE customer_id=$1 AND voice_job_id=$2`,
        [profile.customerId, job.voice_job_id, e?.event_id ?? null],
      );
    });
    return { processed: true };
  } catch {
    await finish(profile, task, (db, job) =>
      failJob(db, profile, job, "failed", "voice_transcription_failed"),
    );
    return { processed: true, failed: true };
  } finally {
    bytes?.fill(0);
    pcm?.fill(0);
  }
}
export async function synthesizeOne(
  profile,
  { synthesize, encode = encodeVoice },
) {
  if (!voiceEnabled(profile)) return { processed: false };
  const task = await claim(profile, "synthesize");
  if (!task) return { processed: false };
  let pcm, ogg;
  try {
    const generated = await synthesize({
      adapterKey: profile.synthesisAdapter,
      credentialRef: profile.synthesisCredentialRef,
      jobId: task.job.voice_job_id,
      text: task.content.body,
      signal: AbortSignal.timeout(60000),
    });
    pcm = Buffer.from(generated);
    generated.fill(0);
    ogg = await encode(pcm);
    const encrypted = encryptAudio(profile, task.job.message_id, ogg);
    await finish(profile, task, async (db, job) => {
      const m = (
        await db.query(
          `SELECT state,body FROM ${s}.assistant_message_outbox WHERE customer_id=$1 AND message_id=$2 FOR UPDATE`,
          [profile.customerId, job.message_id],
        )
      ).rows[0];
      if (m.state !== "preparing" || m.body !== task.content.body) {
        await failJob(db, profile, job, "cancelled", "conversation_changed");
        return;
      }
      await db.query(
        `INSERT INTO ${s}.assistant_voice_assets(customer_id,message_id,ciphertext,iv,auth_tag,key_fingerprint,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour') ON CONFLICT(customer_id,message_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,key_fingerprint=EXCLUDED.key_fingerprint,provider_media_id=NULL,expires_at=EXCLUDED.expires_at`,
        [
          profile.customerId,
          job.message_id,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyFingerprint,
        ],
      );
      await db.query(
        `UPDATE ${s}.assistant_message_outbox SET state='queued',safe_code=NULL,updated_at=now() WHERE customer_id=$1 AND message_id=$2`,
        [profile.customerId, job.message_id],
      );
      await db.query(
        `UPDATE ${s}.assistant_voice_jobs SET state='ready',completed_at=now(),failure_code=NULL WHERE customer_id=$1 AND voice_job_id=$2`,
        [profile.customerId, job.voice_job_id],
      );
    });
    return { processed: true };
  } catch {
    await finish(profile, task, (db, job) =>
      failJob(db, profile, job, "failed", "voice_generation_failed"),
    );
    return { processed: true, failed: true };
  } finally {
    pcm?.fill(0);
    ogg?.fill(0);
  }
}
export async function expireVoiceAssets(profile) {
  return scoped(
    profile,
    async (db) => {
      if (!(await voiceInstalled(db))) return { processed: false };
      const result = await db.query(
        `WITH expired AS (SELECT message_id FROM ${s}.assistant_voice_assets WHERE customer_id=$1 AND ciphertext IS NOT NULL AND expires_at<=now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE ${s}.assistant_voice_assets a SET ciphertext=NULL,iv=NULL,auth_tag=NULL FROM expired e WHERE a.customer_id=$1 AND a.message_id=e.message_id`,
        [profile.customerId],
      );
      await db.query(
        `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='reply_expired',updated_at=now() WHERE customer_id=$1 AND format='audio' AND state IN ('preparing','queued') AND created_at<now()-interval '24 hours'`,
        [profile.customerId],
      );
      return { processed: result.rowCount > 0 };
    },
    { requireEnabled: false },
  );
}

// Uploading a media object is separate from sending a customer message. Reuse its
// ID across definite rate-limit retries; ambiguous message sends are never retried.
export async function prepareVoiceMedia(profile, message, upload) {
  if (!voiceEnabled(profile)) throw new Error("Voice disabled");
  const asset = await scoped(
    profile,
    async (db) =>
      (
        await db.query(
          `SELECT * FROM ${s}.assistant_voice_assets WHERE customer_id=$1 AND message_id=$2 AND expires_at>now()`,
          [profile.customerId, message.message_id],
        )
      ).rows[0],
  );
  if (!asset) throw new Error("Voice expired");
  if (asset.provider_media_id) return asset.provider_media_id;
  if (!asset.ciphertext) throw new Error("Voice unavailable");
  const bytes = decryptAudio(profile, message.message_id, asset);
  try {
    const id = await upload(profile, bytes);
    await scoped(
      profile,
      (db) =>
        db.query(
          `UPDATE ${s}.assistant_voice_assets SET provider_media_id=$3,ciphertext=NULL,iv=NULL,auth_tag=NULL WHERE customer_id=$1 AND message_id=$2`,
          [profile.customerId, message.message_id, id],
        ),
      { requireEnabled: false },
    );
    return id;
  } finally {
    bytes.fill(0);
  }
}
