import { transaction } from "../leads/assistant-settings.service.js";
import { requiredLead, detail } from "../leads/lead-records.service.js";
import { uuid, version, text, hash } from "../leads/lead-records.contracts.js";
import { fail } from "../leads/assistant-settings.contracts.js";
import {
  schema as s,
  installed,
  currentRelease,
  replyState,
} from "./reply-store.js";
export async function responseSettings(actor, company) {
  return transaction(actor, company, async (db, tenant) => {
    await installed(db);
    const releases = (
      await db.query(
        `SELECT r.agent_release_id AS id,a.agent_key AS label,r.release_number AS version FROM ${s}.agents a JOIN ${s}.agent_release_manifests r ON r.agent_release_id=a.active_release_id AND r.customer_id=a.customer_id WHERE a.customer_id=$1 AND a.status='enabled' AND NOT EXISTS(SELECT 1 FROM ${s}.agent_release_revocations x WHERE x.agent_release_id=r.agent_release_id) ORDER BY a.agent_key LIMIT 50`,
        [tenant],
      )
    ).rows;
    const bindings = (
      await db.query(
        `SELECT h.profile_id AS "profileId",b.agent_release_id AS "releaseId",b.mode,b.revision FROM ${s}.assistant_reply_bindings b JOIN ${s}.assistant_channels h USING(customer_id,channel_id) WHERE b.customer_id=$1`,
        [tenant],
      )
    ).rows;
    return { releases, bindings };
  });
}
export async function bindResponse(actor, company, input) {
  const release = uuid(input?.releaseId),
    expected = input?.expectedRevision;
  if (
    !Number.isInteger(expected) ||
    expected < 0 ||
    typeof input?.profileId !== "string" ||
    !["review", "automatic"].includes(input?.mode)
  )
    throw fail("Select valid response settings.");
  return transaction(actor, company, async (db, tenant) => {
    await installed(db);
    await currentRelease(db, tenant, release);
    const channel = (
      await db.query(
        `SELECT channel_id FROM ${s}.assistant_channels WHERE customer_id=$1 AND profile_id=$2`,
        [tenant, input.profileId],
      )
    ).rows[0];
    if (!channel)
      throw fail("Configure receiving before choosing the agent.", 409);
    const row =
      expected === 0
        ? (
            await db.query(
              `INSERT INTO ${s}.assistant_reply_bindings(customer_id,channel_id,agent_release_id,mode,updated_by_identity) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING revision`,
              [tenant, channel.channel_id, release, input.mode, actor],
            )
          ).rows[0]
        : (
            await db.query(
              `UPDATE ${s}.assistant_reply_bindings SET agent_release_id=$3,mode=$4,revision=revision+1,updated_by_identity=$5,updated_at=now() WHERE customer_id=$1 AND channel_id=$2 AND revision=$6 RETURNING revision`,
              [
                tenant,
                channel.channel_id,
                release,
                input.mode,
                actor,
                expected,
              ],
            )
          ).rows[0];
    if (!row)
      throw fail("Response settings changed. Refresh before saving.", 409);
    await db.query(
      `UPDATE ${s}.assistant_lead_conversations c SET ownership='human_requested',human_owner_identity=NULL,ownership_version=ownership_version+1 WHERE c.customer_id=$1 AND c.ownership='bot' AND EXISTS(SELECT 1 FROM ${s}.assistant_channel_contacts t WHERE t.customer_id=c.customer_id AND t.lead_id=c.lead_id AND t.channel_id=$2)`,
      [tenant, channel.channel_id],
    );
    // Binding changes invalidate every undispatched generation/send for this channel.
    await db.query(
      `UPDATE ${s}.assistant_reply_jobs SET state='cancelled',completed_at=now() WHERE customer_id=$1 AND channel_id=$2 AND state IN ('queued','working','ready')`,
      [tenant, channel.channel_id],
    );
    await db.query(
      `UPDATE ${s}.assistant_message_outbox SET state='cancelled',safe_code='settings_changed' WHERE customer_id=$1 AND channel_id=$2 AND state='queued' AND job_id IS NOT NULL`,
      [tenant, channel.channel_id],
    );
    return row;
  });
}
export async function queueReply(actor, company, id, input) {
  uuid(id);
  const key = uuid(input?.requestKey),
    body = text(input?.body, "reply", 4000, true),
    expected = version(input?.expectedVersion);
  return transaction(
    actor,
    company,
    async (db, tenant, access) => {
      await installed(db);
      await requiredLead(db, tenant, access, id, true);
      const old = (
        await db.query(
          `SELECT message_id,request_hash,actor_identity FROM ${s}.assistant_message_outbox WHERE customer_id=$1 AND lead_id=$2 AND request_key=$3`,
          [tenant, id, key],
        )
      ).rows[0];
      if (old) {
        if (old.actor_identity !== actor || old.request_hash !== hash({ body }))
          throw fail("This reply key was already used.", 409);
        return detail(db, tenant, access, id);
      }
      const c = (
        await db.query(
          `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
          [tenant, id],
        )
      ).rows[0];
      if (c.ownership_version !== expected)
        throw fail("Ownership changed. Reload before replying.", 409);
      const state = await replyState(db, tenant, access, id);
      if (!state?.canSend)
        throw fail(
          state?.blockedReason ?? "This lead has no WhatsApp conversation.",
          409,
        );
      await db.query(
        `INSERT INTO ${s}.assistant_message_outbox(customer_id,channel_id,lead_id,conversation_id,ownership_version,actor_identity,body,request_key,request_hash) SELECT $1,t.channel_id,$2,$3,$4,$5,$6,$7,$8 FROM ${s}.assistant_channel_contacts t WHERE t.customer_id=$1 AND t.lead_id=$2`,
        [
          tenant,
          id,
          c.conversation_id,
          expected,
          actor,
          body,
          key,
          hash({ body }),
        ],
      );
      return detail(db, tenant, access, id);
    },
    { inbox: true },
  );
}
export async function draftReply(actor, company, id, input) {
  uuid(id);
  if (process.env.WHATSAPP_GENERATION_ENABLED !== "true")
    throw fail("Sophia drafting is not configured yet.", 409);
  const expected = version(input?.expectedVersion);
  return transaction(
    actor,
    company,
    async (db, tenant, access) => {
      await installed(db);
      const lead = await requiredLead(db, tenant, access, id, true);
      if (lead.stage === "closed")
        throw fail("Reopen the lead before requesting a draft.", 409);
      const c = (
        await db.query(
          `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
          [tenant, id],
        )
      ).rows[0];
      if (
        c.ownership_version !== expected ||
        c.ownership !== "human" ||
        c.human_owner_identity !== actor
      )
        throw fail("Take ownership and reload before drafting an answer.", 409);
      const target = (
        await db.query(
          `SELECT t.channel_id,b.agent_release_id,b.revision AS binding_revision,e.event_id FROM ${s}.assistant_channel_contacts t JOIN ${s}.assistant_reply_bindings b USING(customer_id,channel_id) JOIN ${s}.assistant_lead_events e ON e.customer_id=t.customer_id AND e.conversation_id=$3 AND e.kind='inbound_message' WHERE t.customer_id=$1 AND t.lead_id=$2 AND NOT t.opted_out AND e.metadata->>'messageType'='text' AND COALESCE(e.metadata->>'truncated','false')='false' ORDER BY COALESCE((e.metadata->>'sentAt')::timestamptz,e.created_at) DESC,e.event_id DESC LIMIT 1`,
          [tenant, id, c.conversation_id],
        )
      ).rows[0];
      if (!target)
        throw fail(
          "Choose an approved agent and receive a text enquiry before drafting.",
          409,
        );
      await currentRelease(db, tenant, target.agent_release_id);
      await db.query(
        `INSERT INTO ${s}.assistant_reply_jobs(customer_id,channel_id,lead_id,conversation_id,source_event_id,agent_release_id,ownership_version,requested_by_identity,binding_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
 ON CONFLICT(customer_id,conversation_id,source_event_id,ownership_version,binding_revision) DO UPDATE SET state='queued',lease_id=NULL,lease_until=NULL,completed_at=NULL WHERE ${s}.assistant_reply_jobs.state IN ('failed','needs_human') AND ${s}.assistant_reply_jobs.attempts<2`,
        [
          tenant,
          target.channel_id,
          id,
          c.conversation_id,
          target.event_id,
          target.agent_release_id,
          expected,
          actor,
          target.binding_revision,
        ],
      );
      return detail(db, tenant, access, id);
    },
    { inbox: true },
  );
}
