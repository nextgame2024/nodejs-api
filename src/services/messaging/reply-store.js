import { fail } from "../leads/assistant-settings.contracts.js";
import { channelProfiles } from "./channel-profiles.js";
export const schema = "sophia_runtime";
export async function installed(db) {
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.assistant_message_outbox') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    throw fail(
      "Replies are not available yet. Contact your administrator to finish setup.",
      503,
    );
}
export const canDispatch = (p) =>
  process.env.WHATSAPP_OUTBOUND_ENABLED === "true" &&
  p?.sendingEnabled === true &&
  !!p.accessToken &&
  !!p.graphVersion;
export async function currentRelease(db, tenant, id) {
  const r = (
    await db.query(
      `SELECT r.manifest,r.agent_release_id,a.agent_key,i.content,i.tone,i.greeting
 FROM ${schema}.agent_release_manifests r JOIN ${schema}.agents a ON a.agent_id=r.agent_id AND a.customer_id=r.customer_id
 JOIN ${schema}.instruction_revisions i ON i.instruction_revision_id=(r.manifest->'configuration'->>'instructionRevisionId')::uuid
 JOIN ${schema}.instruction_sets t ON t.instruction_set_id=i.instruction_set_id AND t.customer_id=r.customer_id
 WHERE r.customer_id=$1 AND r.agent_release_id=$2 AND a.status='enabled' AND i.status='approved'
 AND r.platform_safety_policy_version='sophia-safety-1' AND NOT EXISTS(SELECT 1 FROM ${schema}.agent_release_revocations x WHERE x.agent_release_id=r.agent_release_id)`,
      [tenant, id],
    )
  ).rows[0];
  if (
    !r ||
    r.manifest?.tenantId !== tenant ||
    r.manifest?.schemaVersion !== 1 ||
    !Array.isArray(r.manifest.configuration?.knowledgeRevisionIds) ||
    /\{\{/.test([r.content, r.tone, r.greeting].join(" "))
  )
    throw fail(
      "Select a current approved agent release without unresolved variables.",
      409,
    );
  return r;
}
export async function replyState(db, tenant, access, leadId) {
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.assistant_message_outbox') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    return null;
  const c = (
    await db.query(
      `SELECT t.*,h.profile_id,h.enabled,c.ownership,c.human_owner_identity,l.stage,
 COALESCE((SELECT jsonb_agg(q ORDER BY q."createdAt" DESC,q.id) FROM (SELECT job_id AS id,state,answer,sources,created_at AS "createdAt" FROM ${schema}.assistant_reply_jobs WHERE customer_id=$1 AND lead_id=$2 ORDER BY created_at DESC,job_id LIMIT 5)q),'[]'::jsonb) AS jobs,
 COALESCE((SELECT jsonb_agg(q ORDER BY q."createdAt" DESC,q.id) FROM (SELECT message_id AS id,state,safe_code AS "safeCode",created_at AS "createdAt" FROM ${schema}.assistant_message_outbox WHERE customer_id=$1 AND lead_id=$2 ORDER BY created_at DESC,message_id LIMIT 10)q),'[]'::jsonb) AS messages FROM ${schema}.assistant_channel_contacts t JOIN ${schema}.assistant_channels h USING(customer_id,channel_id) JOIN ${schema}.assistant_lead_conversations c USING(customer_id,lead_id) JOIN ${schema}.assistant_leads l USING(customer_id,lead_id) WHERE t.customer_id=$1 AND t.lead_id=$2`,
      [tenant, leadId],
    )
  ).rows[0];
  if (!c) return null;
  const p = channelProfiles().find(
    (p) => p.customerId === tenant && p.id === c.profile_id,
  );
  const windowEndsAt = c.last_inbound_at
    ? new Date(new Date(c.last_inbound_at).getTime() + 86400000).toISOString()
    : null;
  const reason = !c.enabled
    ? "Receiving is paused."
    : !canDispatch(p)
      ? "Sending is not configured."
      : c.opted_out
        ? "This customer opted out."
        : !windowEndsAt || Date.parse(windowEndsAt) <= Date.now()
          ? "Wait for a new customer message to reopen the reply window."
          : c.stage === "closed"
            ? "Reopen this lead before replying."
            : c.ownership !== "human" || c.human_owner_identity !== access.actor
              ? "Take ownership before replying."
              : null;
  return {
    canSend: !reason,
    canResume:
      c.ownership !== "bot" &&
      (!c.human_owner_identity ||
        c.human_owner_identity === access.actor ||
        access.canManageLeads) &&
      !!(await automationTarget(db, tenant, leadId)),
    blockedReason: reason,
    windowEndsAt,
    optedOut: c.opted_out,
    jobs: c.jobs,
    messages: c.messages,
  };
}
export async function enqueueAutomatic(db, profile, leadId, eventId, isNew) {
  if (
    process.env.WHATSAPP_AUTOMATION_ENABLED !== "true" ||
    !profile.reasoningAdapter ||
    !canDispatch(profile)
  )
    return;
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.assistant_reply_jobs') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    return;
  const binding = (
    await db.query(
      `SELECT b.* FROM ${schema}.assistant_reply_bindings b JOIN ${schema}.assistant_channels h USING(customer_id,channel_id) WHERE b.customer_id=$1 AND h.profile_id=$2 AND b.mode='automatic'`,
      [profile.customerId, profile.id],
    )
  ).rows[0];
  if (!binding) return;
  if (isNew)
    await db.query(
      `UPDATE ${schema}.assistant_lead_conversations SET ownership='bot',ownership_version=ownership_version+1 WHERE customer_id=$1 AND lead_id=$2 AND ownership='human_requested'`,
      [profile.customerId, leadId],
    );
  await db.query(
    `INSERT INTO ${schema}.assistant_reply_jobs(customer_id,channel_id,lead_id,conversation_id,source_event_id,agent_release_id,ownership_version,binding_revision)
 SELECT c.customer_id,t.channel_id,c.lead_id,c.conversation_id,$3,$4,c.ownership_version,$5 FROM ${schema}.assistant_lead_conversations c JOIN ${schema}.assistant_channel_contacts t USING(customer_id,lead_id) JOIN ${schema}.assistant_leads l USING(customer_id,lead_id)
 WHERE c.customer_id=$1 AND c.lead_id=$2 AND c.ownership='bot' AND l.stage<>'closed' AND NOT t.opted_out ON CONFLICT DO NOTHING`,
    [
      profile.customerId,
      leadId,
      eventId,
      binding.agent_release_id,
      binding.revision,
    ],
  );
}
export async function sourcesAvailable(db, tenant, release, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 5) return false;
  const c = release.manifest.configuration;
  return (
    (
      await db.query(
        `SELECT count(DISTINCT x.knowledge_snapshot_id)::int AS count FROM ${schema}.knowledge_snapshots x JOIN ${schema}.knowledge_source_revisions r ON r.knowledge_revision_id=x.knowledge_revision_id AND r.customer_id=x.customer_id JOIN ${schema}.knowledge_sources k ON k.knowledge_source_id=r.knowledge_source_id AND k.customer_id=x.customer_id JOIN ${schema}.knowledge_snapshot_grants g ON g.knowledge_snapshot_id=x.knowledge_snapshot_id AND g.customer_id=x.customer_id JOIN ${schema}.capability_bindings b ON b.capability_binding_id=g.capability_binding_id WHERE x.customer_id=$1 AND x.knowledge_snapshot_id=ANY($2::uuid[]) AND x.status='published' AND r.status='published' AND r.ingestion_status='ready' AND k.status='active' AND b.enabled AND r.knowledge_revision_id=ANY($3::uuid[]) AND g.capability_binding_id=ANY($4::uuid[]) AND b.business_profile_version_id=$5`,
        [
          tenant,
          ids,
          c.knowledgeRevisionIds,
          c.capabilityBindingIds,
          c.businessProfileVersionId,
        ],
      )
    ).rows[0].count === new Set(ids).size
  );
}
export async function invalidateOlderReplies(db, tenant, leadId, eventId) {
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.assistant_reply_jobs') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    return;
  await db.query(
    `UPDATE ${schema}.assistant_reply_jobs SET state='cancelled',completed_at=now() WHERE customer_id=$1 AND lead_id=$2 AND source_event_id<$3 AND state IN ('queued','working','ready')`,
    [tenant, leadId, eventId],
  );
  await db.query(
    `UPDATE ${schema}.assistant_message_outbox o SET state='cancelled',safe_code='newer_message' FROM ${schema}.assistant_reply_jobs j WHERE o.customer_id=$1 AND o.lead_id=$2 AND o.state='queued' AND o.job_id=j.job_id AND j.customer_id=o.customer_id AND j.source_event_id<$3`,
    [tenant, leadId, eventId],
  );
}
export async function providerAllowed(db, tenant, release, profile) {
  if (!profile.reasoningCredentialRef) return false;
  const c = release.manifest.configuration;
  return !!(
    await db.query(
      `SELECT 1 FROM ${schema}.experience_profile_versions v JOIN ${schema}.experience_profiles x ON x.experience_profile_id=v.experience_profile_id JOIN ${schema}.experience_provider_bindings b ON b.experience_profile_version_id=v.experience_profile_version_id AND b.capability_key='reasoning' JOIN ${schema}.provider_configurations p ON p.provider_configuration_id=b.provider_configuration_id WHERE x.customer_id=$1 AND x.enabled AND v.status='published' AND v.experience_profile_version_id=ANY($2::uuid[]) AND v.business_profile_version_id=$3 AND v.pipeline_mode IN ('orchestrated-text','orchestrated-voice') AND p.customer_id=$1 AND p.status='published' AND p.adapter_key=$4 AND p.credential_ref=$5 AND p.settings='{}'::jsonb LIMIT 1`,
      [
        tenant,
        c.experienceProfileVersionIds ?? [],
        c.businessProfileVersionId,
        profile.reasoningAdapter,
        profile.reasoningCredentialRef,
      ],
    )
  ).rows.length;
}
export async function automationTarget(db, tenant, leadId) {
  if (
    process.env.WHATSAPP_AUTOMATION_ENABLED !== "true" ||
    process.env.WHATSAPP_GENERATION_ENABLED !== "true"
  )
    return null;
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.assistant_reply_bindings') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    return null;
  const row = (
    await db.query(
      `SELECT h.profile_id,b.agent_release_id,e.event_id FROM ${schema}.assistant_channel_contacts t JOIN ${schema}.assistant_channels h USING(customer_id,channel_id) JOIN ${schema}.assistant_reply_bindings b USING(customer_id,channel_id) JOIN ${schema}.assistant_lead_conversations c USING(customer_id,lead_id) JOIN ${schema}.assistant_leads l USING(customer_id,lead_id) JOIN LATERAL(SELECT event_id,metadata FROM ${schema}.assistant_lead_events WHERE customer_id=t.customer_id AND conversation_id=c.conversation_id AND kind='inbound_message' ORDER BY COALESCE((metadata->>'sentAt')::timestamptz,created_at) DESC,event_id DESC LIMIT 1)e ON true WHERE t.customer_id=$1 AND t.lead_id=$2 AND h.enabled AND b.mode='automatic' AND l.stage<>'closed' AND NOT t.opted_out AND t.last_inbound_at>now()-interval '24 hours' AND t.last_inbound_at<=now() AND e.metadata->>'messageType'='text' AND COALESCE(e.metadata->>'truncated','false')='false'`,
      [tenant, leadId],
    )
  ).rows[0];
  if (!row) return null;
  const profile = channelProfiles().find(
    (p) => p.customerId === tenant && p.id === row.profile_id,
  );
  if (!canDispatch(profile)) return null;
  try {
    const release = await currentRelease(db, tenant, row.agent_release_id);
    if (!(await providerAllowed(db, tenant, release, profile))) return null;
  } catch (e) {
    if (e.status !== 409) throw e;
    return null;
  }
  return { profile, eventId: row.event_id };
}
