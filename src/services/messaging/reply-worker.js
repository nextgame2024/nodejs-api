import {
  queueVoicePair,
  voiceInstalled,
  voiceEnabled,
  approveSpeech,
} from "./voice-store.js";
import { recordAccepted } from "./delivery-store.js";
import { randomUUID } from "node:crypto";
import { scoped } from "./whatsapp-channel.service.js";
import {
  schema as s,
  installed,
  currentRelease,
  sourcesAvailable,
  providerAllowed,
  canDispatch,
} from "./reply-store.js";
import { directory } from "../leads/assistant-settings.service.js";
import { hash } from "../leads/lead-records.contracts.js";
async function handoffJob(db, tenant, job, state = "needs_human") {
  await db.query(
    `UPDATE ${s}.assistant_reply_jobs SET state=$3,completed_at=now() WHERE customer_id=$1 AND job_id=$2`,
    [tenant, job.job_id, state],
  );
  if (!job.requested_by_identity)
    await db.query(
      `UPDATE ${s}.assistant_lead_conversations SET ownership='human_requested',ownership_version=ownership_version+1 WHERE customer_id=$1 AND conversation_id=$2 AND ownership='bot' AND ownership_version=$3`,
      [tenant, job.conversation_id, job.ownership_version],
    );
}
// Dependency-injected reasoning and transport ports: no concrete model in services.
export async function generateOne(profile, reasoner) {
  if (
    process.env.WHATSAPP_GENERATION_ENABLED !== "true" ||
    !profile.reasoningAdapter
  )
    return { processed: false };
  const task = await scoped(profile, async (db, channel, company) => {
    await installed(db);
    const candidate = (
      await db.query(
        `SELECT * FROM ${s}.assistant_reply_jobs WHERE customer_id=$1 AND channel_id=$2 AND (state='queued' OR (state='working' AND lease_until<now())) ORDER BY created_at LIMIT 1`,
        [profile.customerId, channel.channel_id],
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
        `SELECT * FROM ${s}.assistant_reply_jobs WHERE customer_id=$1 AND job_id=$2 AND (state='queued' OR (state='working' AND lease_until<now())) FOR UPDATE SKIP LOCKED`,
        [profile.customerId, candidate.job_id],
      )
    ).rows[0];
    if (!job) return null;
    const contact = (
      await db.query(
        `SELECT *,last_inbound_at>now()-interval '24 hours' AND last_inbound_at<=now() AS window_open FROM ${s}.assistant_channel_contacts WHERE customer_id=$1 AND lead_id=$2`,
        [profile.customerId, lead.lead_id],
      )
    ).rows[0];
    const binding = (
      await db.query(
        `SELECT * FROM ${s}.assistant_reply_bindings WHERE customer_id=$1 AND channel_id=$2`,
        [profile.customerId, channel.channel_id],
      )
    ).rows[0];
    const e = (
      await db.query(
        `SELECT * FROM ${s}.assistant_lead_events WHERE customer_id=$1 AND conversation_id=$2 AND kind='inbound_message' ORDER BY COALESCE((metadata->>'sentAt')::timestamptz,created_at) DESC,COALESCE((metadata->>'transcriptOf')::bigint,event_id) DESC,event_id DESC LIMIT 1`,
        [profile.customerId, c.conversation_id],
      )
    ).rows[0];
    const owned = job.requested_by_identity
      ? c.ownership === "human" &&
        c.human_owner_identity === job.requested_by_identity
      : c.ownership === "bot" &&
        binding?.mode === "automatic" &&
        process.env.WHATSAPP_AUTOMATION_ENABLED === "true";
    if (
      (!job.requested_by_identity && !contact.window_open) ||
      (job.requested_by_identity &&
        !(await authorizedSender(
          db,
          company,
          profile.customerId,
          job.requested_by_identity,
          job.lead_id,
        ))) ||
      lead.stage === "closed" ||
      contact.opted_out ||
      !owned ||
      c.ownership_version !== job.ownership_version ||
      binding?.agent_release_id !== job.agent_release_id ||
      binding?.revision !== job.binding_revision ||
      e?.event_id !== job.source_event_id ||
      e?.metadata.messageType !== "text" ||
      e?.metadata.truncated
    ) {
      await db.query(
        `UPDATE ${s}.assistant_reply_jobs SET state='cancelled',completed_at=now() WHERE customer_id=$1 AND job_id=$2`,
        [profile.customerId, job.job_id],
      );
      return null;
    }
    if (job.attempts >= 2) {
      await handoffJob(db, profile.customerId, job, "failed");
      return null;
    }
    let release;
    try {
      release = await currentRelease(
        db,
        profile.customerId,
        job.agent_release_id,
      );
    } catch (e) {
      if (e.status !== 409) throw e;
      await handoffJob(db, profile.customerId, job);
      return null;
    }
    if (!(await providerAllowed(db, profile.customerId, release, profile))) {
      await handoffJob(db, profile.customerId, job);
      return null;
    }
    const config = release.manifest.configuration;
    const words = [
      ...new Set(e.body.toLowerCase().match(/[\p{L}\p{N}]{3,40}/gu) ?? []),
    ].slice(0, 12);
    const sources = (
      await db.query(
        `SELECT x.knowledge_snapshot_id AS id,d.title,left(d.document_text,3000) AS content FROM ${s}.knowledge_snapshots x JOIN ${s}.knowledge_source_revisions r ON r.knowledge_revision_id=x.knowledge_revision_id AND r.customer_id=x.customer_id JOIN ${s}.knowledge_sources k ON k.knowledge_source_id=r.knowledge_source_id AND k.customer_id=x.customer_id JOIN ${s}.knowledge_index_documents d ON d.knowledge_snapshot_id=x.knowledge_snapshot_id AND d.customer_id=x.customer_id
  WHERE x.customer_id=$1 AND x.status='published' AND r.status='published' AND r.ingestion_status='ready' AND k.status='active' AND r.knowledge_revision_id=ANY($2::uuid[])
  AND EXISTS(SELECT 1 FROM ${s}.knowledge_snapshot_grants g JOIN ${s}.capability_bindings b ON b.capability_binding_id=g.capability_binding_id WHERE g.customer_id=x.customer_id AND g.knowledge_snapshot_id=x.knowledge_snapshot_id AND b.enabled AND b.business_profile_version_id=$3 AND g.capability_binding_id=ANY($4::uuid[]))
  AND d.search_vector @@ websearch_to_tsquery('simple',$5) ORDER BY ts_rank_cd(d.search_vector,websearch_to_tsquery('simple',$5)) DESC,x.knowledge_snapshot_id LIMIT 5`,
        [
          profile.customerId,
          config.knowledgeRevisionIds,
          config.businessProfileVersionId,
          config.capabilityBindingIds,
          words.join(" OR "),
        ],
      )
    ).rows;
    if (!sources.length) {
      await handoffJob(db, profile.customerId, job);
      if (!job.requested_by_identity)
        await db.query(
          `UPDATE ${s}.assistant_lead_conversations SET ownership='human_requested',ownership_version=ownership_version+1 WHERE customer_id=$1 AND conversation_id=$2`,
          [profile.customerId, c.conversation_id],
        );
      return null;
    }
    const lease = randomUUID();
    await db.query(
      `UPDATE ${s}.assistant_reply_jobs SET state='working',lease_id=$3,lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE customer_id=$1 AND job_id=$2`,
      [profile.customerId, job.job_id, lease],
    );
    return {
      job,
      lease,
      instructions: [release.content, release.tone].filter(Boolean).join("\n"),
      question: e.body,
      language: lead.language,
      sources,
    };
  });
  if (!task) return { processed: false };
  let result;
  try {
    result = await reasoner({
      adapterKey: profile.reasoningAdapter,
      credentialRef: profile.reasoningCredentialRef,
      jobId: task.job.job_id,
      instructions: task.instructions,
      question: task.question,
      language: task.language,
      sources: task.sources,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    result = { handoff: true, answer: "", sourceIds: [], failed: true };
  }
  result ??= { handoff: true, failed: true };
  const allowed = new Set(task.sources.map((x) => x.id));
  const valid =
    result &&
    result.handoff === false &&
    typeof result.answer === "string" &&
    result.answer.trim().length > 0 &&
    result.answer.length <= 4000 &&
    Array.isArray(result.sourceIds) &&
    result.sourceIds.length > 0 &&
    result.sourceIds.length <= 5 &&
    result.sourceIds.every((id) => allowed.has(id));
  await scoped(
    profile,
    async (db, channel) => {
      await db.query(
        `SELECT lead_id FROM ${s}.assistant_leads WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
        [profile.customerId, task.job.lead_id],
      );
      const c = (
        await db.query(
          `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND conversation_id=$2 FOR UPDATE`,
          [profile.customerId, task.job.conversation_id],
        )
      ).rows[0];
      const job = (
        await db.query(
          `SELECT * FROM ${s}.assistant_reply_jobs WHERE customer_id=$1 AND job_id=$2 AND state='working' AND lease_id=$3 AND lease_until>now() FOR UPDATE`,
          [profile.customerId, task.job.job_id, task.lease],
        )
      ).rows[0];
      if (!job || c.ownership_version !== job.ownership_version) return;
      let checkedRelease;
      try {
        checkedRelease = await currentRelease(
          db,
          profile.customerId,
          job.agent_release_id,
        );
      } catch (e) {
        if (e.status !== 409) throw e;
        result = { handoff: true };
      }
      // Recheck every cited source/grant after external generation, including retirement.
      const stillPublished =
        checkedRelease &&
        (await sourcesAvailable(
          db,
          profile.customerId,
          checkedRelease,
          task.sources.map((x) => x.id),
        ));
      const accepted =
        valid &&
        stillPublished &&
        checkedRelease &&
        (await providerAllowed(
          db,
          profile.customerId,
          checkedRelease,
          profile,
        )) &&
        !result.handoff;
      await db.query(
        `UPDATE ${s}.assistant_reply_jobs SET state=$3,answer=$4,sources=$5::jsonb,usage=$6::jsonb,completed_at=now() WHERE customer_id=$1 AND job_id=$2`,
        [
          profile.customerId,
          job.job_id,
          accepted ? "ready" : result.failed ? "failed" : "needs_human",
          accepted ? result.answer.trim() : null,
          JSON.stringify(accepted ? result.sourceIds : []),
          JSON.stringify({
            attempts: [
              ...(Array.isArray(job.usage?.attempts) ? job.usage.attempts : []),
              result.usage ?? { measurementStatus: "incomplete" },
            ].slice(-2),
          }),
        ],
      );
      if (!accepted && !job.requested_by_identity)
        await db.query(
          `UPDATE ${s}.assistant_lead_conversations SET ownership='human_requested',ownership_version=ownership_version+1 WHERE customer_id=$1 AND conversation_id=$2`,
          [profile.customerId, c.conversation_id],
        );
      if (
        accepted &&
        !job.requested_by_identity &&
        process.env.WHATSAPP_AUTOMATION_ENABLED === "true"
      ) {
        const queued = await db.query(
          `INSERT INTO ${s}.assistant_message_outbox(customer_id,channel_id,lead_id,conversation_id,ownership_version,body,request_key,request_hash,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7) ON CONFLICT DO NOTHING RETURNING message_id`,
          [
            profile.customerId,
            channel.channel_id,
            job.lead_id,
            job.conversation_id,
            job.ownership_version,
            result.answer.trim(),
            job.job_id,
            hash({ body: result.answer.trim() }),
          ],
        );
        if (queued.rows[0])
          await queueVoicePair(
            db,
            profile.customerId,
            queued.rows[0].message_id,
          );
      }
    },
    { requireEnabled: false },
  );
  return { processed: true };
}
async function authorizedSender(db, company, tenant, actor, leadId) {
  if (!actor) return true;
  if (!(await directory(db, company, { ids: [actor] })).length) return false;
  return (
    await db.query(
      `SELECT EXISTS(SELECT 1 FROM ${s}.admin_memberships WHERE customer_id=$1 AND identity_user_id=$2 AND status='active' AND role_key='organisation_owner') OR EXISTS(SELECT 1 FROM ${s}.business_pack_entitlements WHERE customer_id=$1 AND identity_user_id=$2 AND status='active' AND pack_id='student-operations' AND role_key='chief_executive') OR EXISTS(SELECT 1 FROM ${s}.lead_assistant_setting_releases r WHERE r.customer_id=$1 AND (r.configuration->>'enquiryOwnerId'=$2 OR r.configuration->>'fallbackOwnerId'=$2 OR (r.configuration->'advisorIds' ? $2 AND EXISTS(SELECT 1 FROM ${s}.assistant_leads l WHERE l.customer_id=$1 AND l.lead_id=$3 AND l.assigned_to_identity=$2))) AND r.source_revision=(SELECT max(source_revision) FROM ${s}.lead_assistant_setting_releases WHERE customer_id=$1)) AS allowed`,
      [tenant, actor, leadId],
    )
  ).rows[0].allowed;
}
export async function dispatchOne(profile, send, { prepareAudio } = {}) {
  if (!canDispatch(profile)) return { processed: false };
  const task = await scoped(profile, async (db, channel, company) => {
    await installed(db);
    // Expired dispatches are ambiguous, never automatically returned to the queue.
    await db.query(
      `UPDATE ${s}.assistant_message_outbox SET state='unknown',safe_code='send_unconfirmed',updated_at=now() WHERE customer_id=$1 AND channel_id=$2 AND state='dispatching' AND dispatch_until<now()`,
      [profile.customerId, channel.channel_id],
    );
    const voice = await voiceInstalled(db);
    const candidate = (
      await db.query(
        `SELECT o.* FROM ${s}.assistant_message_outbox o WHERE customer_id=$1 AND channel_id=$2 AND state='queued' AND available_at<=now() ${voice ? `AND (format='text' OR (${voiceEnabled(profile) ? "true" : "false"} AND EXISTS(SELECT 1 FROM sophia_runtime.assistant_message_outbox parent WHERE parent.customer_id=o.customer_id AND parent.message_id=o.parent_message_id AND parent.state IN ('accepted','delivered','read'))))` : ""} ORDER BY created_at LIMIT 1`,
        [profile.customerId, channel.channel_id],
      )
    ).rows[0];
    if (!candidate) return null;
    const lead = (
      await db.query(
        `SELECT stage FROM ${s}.assistant_leads WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
        [profile.customerId, candidate.lead_id],
      )
    ).rows[0];
    const c = (
      await db.query(
        `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND conversation_id=$2 FOR UPDATE`,
        [profile.customerId, candidate.conversation_id],
      )
    ).rows[0];
    const m = (
      await db.query(
        `SELECT * FROM ${s}.assistant_message_outbox WHERE customer_id=$1 AND message_id=$2 AND state='queued' FOR UPDATE SKIP LOCKED`,
        [profile.customerId, candidate.message_id],
      )
    ).rows[0];
    if (!m) return null;
    const contact = (
      await db.query(
        `SELECT *,last_inbound_at>now()-interval '24 hours' AND last_inbound_at<=now() AS window_open FROM ${s}.assistant_channel_contacts WHERE customer_id=$1 AND lead_id=$2`,
        [profile.customerId, m.lead_id],
      )
    ).rows[0];
    let permitted = m.actor_identity
      ? c.ownership === "human" && c.human_owner_identity === m.actor_identity
      : process.env.WHATSAPP_AUTOMATION_ENABLED === "true" &&
        c.ownership === "bot";
    if (m.voice_failure_job_id) {
      const j = (
        await db.query(
          `SELECT j.state,j.source_event_id FROM ${s}.assistant_voice_jobs j WHERE customer_id=$1 AND voice_job_id=$2`,
          [profile.customerId, m.voice_failure_job_id],
        )
      ).rows[0];
      const latest = (
        await db.query(
          `SELECT event_id FROM ${s}.assistant_lead_events WHERE customer_id=$1 AND conversation_id=$2 AND kind='inbound_message' ORDER BY COALESCE((metadata->>'sentAt')::timestamptz,created_at) DESC,COALESCE((metadata->>'transcriptOf')::bigint,event_id) DESC,event_id DESC LIMIT 1`,
          [profile.customerId, m.conversation_id],
        )
      ).rows[0];
      permitted =
        process.env.WHATSAPP_AUTOMATION_ENABLED === "true" &&
        c.ownership === "human_requested" &&
        j?.state === "failed" &&
        j.source_event_id === latest?.event_id;
    }
    if (m.job_id) {
      const j = (
        await db.query(
          `SELECT j.state,b.mode,j.agent_release_id,j.sources,j.binding_revision,b.revision FROM ${s}.assistant_reply_jobs j JOIN ${s}.assistant_reply_bindings b USING(customer_id,channel_id,agent_release_id) WHERE j.customer_id=$1 AND j.job_id=$2`,
          [profile.customerId, m.job_id],
        )
      ).rows[0];
      permitted =
        permitted &&
        j?.state === "ready" &&
        j.mode === "automatic" &&
        j.binding_revision === j.revision;
      if (j)
        try {
          const release = await currentRelease(
            db,
            profile.customerId,
            j.agent_release_id,
          );
          permitted =
            permitted &&
            (await providerAllowed(db, profile.customerId, release, profile)) &&
            (await sourcesAvailable(
              db,
              profile.customerId,
              release,
              j.sources,
            ));
        } catch (e) {
          if (e.status !== 409) throw e;
          permitted = false;
        }
    }
    if (
      !permitted ||
      c.ownership_version !== m.ownership_version ||
      lead.stage === "closed" ||
      contact.opted_out ||
      !contact.window_open ||
      !(await authorizedSender(
        db,
        company,
        profile.customerId,
        m.actor_identity,
        m.lead_id,
      )) ||
      m.attempts >= 5
    ) {
      await db.query(
        `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='reply_no_longer_allowed',updated_at=now() WHERE customer_id=$1 AND message_id=$2`,
        [profile.customerId, m.message_id],
      );
      return null;
    }
    if (m.format === "audio" && !voiceEnabled(profile)) return null;
    if (m.format === "audio") {
      const j = (
        await db.query(
          `SELECT j.* FROM ${s}.assistant_voice_jobs j JOIN ${s}.assistant_reply_bindings b USING(customer_id,channel_id,agent_release_id) WHERE j.customer_id=$1 AND j.message_id=$2 AND j.state='ready' AND j.binding_revision=b.revision`,
          [profile.customerId, m.message_id],
        )
      ).rows[0];
      let allowed = false;
      try {
        allowed =
          !!j && (await approveSpeech(db, profile.customerId, j, profile));
      } catch (e) {
        if (e.status !== 409) throw e;
      }
      if (!allowed) {
        await db.query(
          `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='configuration_required' WHERE customer_id=$1 AND message_id=$2`,
          [profile.customerId, m.message_id],
        );
        return null;
      }
    }
    const dispatch = randomUUID();
    await db.query(
      `UPDATE ${s}.assistant_message_outbox SET state='dispatching',dispatch_id=$3,dispatch_until=now()+interval '1 minute',attempts=attempts+1 WHERE customer_id=$1 AND message_id=$2`,
      [profile.customerId, m.message_id, dispatch],
    );
    return { m, dispatch, recipient: contact.sender_id };
  });
  if (!task) return { processed: false };
  let result, mediaId;
  if (task.m.format === "audio") {
    try {
      if (!prepareAudio) throw new Error("Voice transport unavailable");
      mediaId = await prepareAudio(profile, task.m);
    } catch {
      result = { kind: "failed", code: "voice_preparation_failed" };
    }
  }
  try {
    if (!result)
      result = await send(profile, {
        ...(mediaId ? { mediaId } : {}),
        messageId: task.m.message_id,
        body: task.m.body,
        recipient: task.recipient,
      });
  } catch {
    result = { kind: "unknown", code: "send_unconfirmed" };
  }
  await scoped(
    profile,
    async (db) => {
      const m = (
        await db.query(
          `SELECT * FROM ${s}.assistant_message_outbox WHERE customer_id=$1 AND message_id=$2 AND dispatch_id=$3 FOR UPDATE`,
          [profile.customerId, task.m.message_id, task.dispatch],
        )
      ).rows[0];
      if (!m || !["dispatching", "unknown"].includes(m.state)) return;
      const state =
        {
          accepted: "accepted",
          retry: "queued",
          failed: "failed",
          unknown: "unknown",
        }[result.kind] ?? "unknown";
      await db.query(
        `UPDATE ${s}.assistant_message_outbox SET state=$3,provider_message_id=$4,safe_code=$5,available_at=now()+($6::int*interval '1 second'),updated_at=now() WHERE customer_id=$1 AND message_id=$2`,
        [
          profile.customerId,
          m.message_id,
          state,
          result.providerMessageId ?? null,
          result.code ?? null,
          result.kind === "retry" ? result.seconds : 0,
        ],
      );
      if (state === "accepted")
        await recordAccepted(
          db,
          profile.customerId,
          m,
          result.providerMessageId,
        );
    },
    { requireEnabled: false },
  );
  return { processed: true };
}
