import { seal, unseal } from "./whatsapp-credentials.js";
import { channelProfiles } from "./channel-profiles.js";
import { fail } from "../leads/assistant-settings.contracts.js";
const s = "sophia_runtime";
export const connectionProfileId = (env) =>
  `${env.WHATSAPP_SIGNUP_BASE_PROFILE}_real`;
export async function connectionScope(work, env = process.env, database) {
  database ??= (await import("../../config/db.js")).default;
  const db = await database.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE sophia_runtime_app");
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
      env.WHATSAPP_SIGNUP_CUSTOMER_ID,
    ]);
    const r = await work(db, env.WHATSAPP_SIGNUP_CUSTOMER_ID);
    await db.query("COMMIT");
    return r;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function stageConnection(
  db,
  tenant,
  actor,
  phone,
  account,
  token,
  env = process.env,
) {
  const base = channelProfiles(env).find(
    (p) => p.customerId === tenant && p.id === env.WHATSAPP_SIGNUP_BASE_PROFILE,
  );
  if (!base?.ready || tenant !== env.WHATSAPP_SIGNUP_CUSTOMER_ID)
    throw fail("The WhatsApp activation settings are incomplete.", 503);
  if (channelProfiles(env).some((p) => p.phoneNumberId === phone.id))
    throw fail("This number is already connected.", 409);
  const id = connectionProfileId(env),
    key = Buffer.from(env.WHATSAPP_SIGNUP_ENCRYPTION_KEY, "base64");
  const result = await db.query(
    `INSERT INTO ${s}.whatsapp_connections(customer_id,profile_id,business_account_id,phone_number_id,display_phone_number,encrypted_token,actor_identity) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(customer_id) DO UPDATE SET business_account_id=EXCLUDED.business_account_id,phone_number_id=EXCLUDED.phone_number_id,display_phone_number=EXCLUDED.display_phone_number,encrypted_token=EXCLUDED.encrypted_token,actor_identity=EXCLUDED.actor_identity,state='activating',step='subscribe',operation_state='pending',contacts_request_id=NULL,history_request_id=NULL,history_progress=0,history_declined=false,contacts_received=false,failure_code=NULL,operation_started_at=NULL,next_attempt_at=now(),sync_deadline=now()+interval '24 hours',updated_at=now() WHERE whatsapp_connections.state='disconnected' RETURNING profile_id`,
    [
      tenant,
      id,
      account,
      phone.id,
      phone.display_phone_number,
      JSON.stringify(seal(token, key, `${tenant}:${id}`)),
      actor,
    ],
  );
  if (!result.rowCount)
    throw fail(
      "This number has an activation in progress. Refresh to review its status.",
      409,
    );
  await db.query(
    `INSERT INTO ${s}.assistant_channels(customer_id,profile_id,phone_number_id,business_account_id,enabled,updated_by_identity) VALUES($1,$2,$3,$4,true,$5) ON CONFLICT(customer_id,profile_id) DO UPDATE SET phone_number_id=EXCLUDED.phone_number_id,business_account_id=EXCLUDED.business_account_id,enabled=true,revision=assistant_channels.revision+1,updated_by_identity=EXCLUDED.updated_by_identity`,
    [tenant, id, phone.id, account, actor],
  );
  await db.query(
    `UPDATE ${s}.assistant_reply_bindings b SET mode='review',revision=b.revision+1 WHERE customer_id=$1 AND channel_id IN(SELECT channel_id FROM ${s}.assistant_channels WHERE customer_id=$1 AND profile_id=$2)`,
    [tenant, id],
  );
  await db.query(
    `INSERT INTO ${s}.lead_assistant_settings_audit(customer_id,actor_identity,action,revision) VALUES($1,$2,'channel_updated',1)`,
    [tenant, actor],
  );
}
// Claim and commit before the one-shot API request. An uncertain result requires
// reconciliation, never automatic replay. No network call holds a row lock.
export async function activationTick({
  env = process.env,
  scope = (work) => connectionScope(work, env),
  fetcher = fetch,
} = {}) {
  const job = await scope(async (db, tenant) => {
    await db.query(
      `UPDATE ${s}.whatsapp_connections SET state='attention',operation_state='uncertain',failure_code='operation_outcome_unknown',updated_at=now() WHERE customer_id=$1 AND operation_state='running' AND operation_started_at<now()-interval '60 seconds'`,
      [tenant],
    );
    await db.query(
      `UPDATE ${s}.whatsapp_connections SET state='attention',failure_code='synchronization_deadline' WHERE customer_id=$1 AND state IN ('activating','syncing') AND sync_deadline<now()`,
      [tenant],
    );
    const r = (
      await db.query(
        `SELECT * FROM ${s}.whatsapp_connections WHERE customer_id=$1 AND state='activating' AND operation_state='pending' AND next_attempt_at<=now() FOR UPDATE SKIP LOCKED`,
        [tenant],
      )
    ).rows[0];
    if (!r) return null;
    await db.query(
      `UPDATE ${s}.whatsapp_connections SET operation_state='running',operation_started_at=now(),updated_at=now() WHERE customer_id=$1`,
      [tenant],
    );
    return r;
  });
  if (!job) return { processed: false };
  const base = channelProfiles(env).find(
    (p) =>
      p.id === env.WHATSAPP_SIGNUP_BASE_PROFILE &&
      p.customerId === job.customer_id,
  );
  const token = unseal(
    job.encrypted_token,
    Buffer.from(env.WHATSAPP_SIGNUP_ENCRYPTION_KEY, "base64"),
    `${job.customer_id}:${job.profile_id}`,
  );
  const subscribe = job.step === "subscribe";
  const endpoint = subscribe
    ? `${job.business_account_id}/subscribed_apps`
    : `${job.phone_number_id}/smb_app_data`;
  const callback = new URL(
    `/api/webhooks/whatsapp/${job.profile_id}`,
    env.WHATSAPP_SIGNUP_API_ORIGIN,
  );
  if (callback.protocol !== "https:")
    throw Error("Invalid activation callback");
  let result, failure;
  try {
    const response = await fetcher(
      `https://graph.facebook.com/${base.graphVersion}/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          subscribe
            ? {
                override_callback_uri: callback.href,
                verify_token: base.verifyToken,
              }
            : {
                messaging_product: "whatsapp",
                sync_type:
                  job.step === "contacts" ? "smb_app_state_sync" : "history",
              },
        ),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      failure = "meta_request_rejected";
    } else {
      result = await response.json();
      if (
        result.error ||
        (subscribe
          ? result.success !== true
          : typeof result.request_id !== "string")
      )
        failure = "meta_response_invalid";
    }
  } catch {
    failure = "operation_outcome_unknown";
  }
  await scope(async (db, tenant) => {
    // A disconnect webhook may have revoked this job while the request ran.
    if (failure) {
      await db.query(
        `UPDATE ${s}.whatsapp_connections SET state='attention',operation_state='uncertain',failure_code=$2,updated_at=now() WHERE customer_id=$1 AND state='activating' AND operation_state='running'`,
        [tenant, failure],
      );
      return;
    }
    const next = {
      subscribe: "contacts",
      contacts: "history",
      history: "done",
    }[job.step];
    await db.query(
      `UPDATE ${s}.whatsapp_connections SET step=$2,operation_state=CASE WHEN $2='done' THEN 'accepted' ELSE 'pending' END,state=CASE WHEN $2='done' THEN 'syncing' ELSE 'activating' END,contacts_request_id=CASE WHEN $3='contacts' THEN $4 ELSE contacts_request_id END,history_request_id=CASE WHEN $3='history' THEN $4 ELSE history_request_id END,updated_at=now() WHERE customer_id=$1 AND state='activating' AND operation_state='running'`,
      [tenant, next, job.step, result.request_id ?? null],
    );
    await readyConnection(db, tenant, env.WHATSAPP_SIGNUP_BASE_PROFILE);
  });
  return { processed: true };
}
export async function readyConnection(db, tenant, baseProfileId) {
  await db.query(
    `UPDATE ${s}.whatsapp_connections SET state='ready',failure_code=NULL,updated_at=now() WHERE customer_id=$1 AND state='syncing' AND step='done' AND (history_progress=100 OR history_declined)`,
    [tenant],
  );
  // A newly connected channel deliberately starts in manual mode. The existing
  // Company controls enable automatic replies after the owner verifies a pilot.
  await db.query(
    `INSERT INTO ${s}.assistant_reply_bindings(customer_id,channel_id,agent_release_id,mode,updated_by_identity) SELECT c.customer_id,h.channel_id,b.agent_release_id,'review',c.actor_identity FROM ${s}.whatsapp_connections c JOIN ${s}.assistant_channels h ON h.customer_id=c.customer_id AND h.profile_id=c.profile_id JOIN ${s}.assistant_channels old ON old.customer_id=c.customer_id AND old.profile_id=$2 JOIN ${s}.assistant_reply_bindings b ON b.customer_id=old.customer_id AND b.channel_id=old.channel_id WHERE c.customer_id=$1 AND c.state='ready' ON CONFLICT(customer_id,channel_id) DO NOTHING`,
    [tenant, baseProfileId],
  );
}
export function startCoexistenceWorkflow({
  env = process.env,
  intervalMs = 2000,
  logger = console,
} = {}) {
  if (env.WHATSAPP_COEXISTENCE_ACTIVATION_ENABLED !== "true") return () => {};
  let stopped = false,
    timer;
  const run = async () => {
    try {
      await activationTick({ env });
      await processSyncReceipt({ env });
      await connectionScope(async (db, t) => {
        await db.query(
          `DELETE FROM ${s}.whatsapp_sync_receipts WHERE customer_id=$1 AND expires_at<now()`,
          [t],
        );
        await db.query(
          `UPDATE ${s}.assistant_whatsapp_signup SET encrypted_token=NULL,state=CASE WHEN state='verified' THEN state ELSE 'failed' END WHERE customer_id=$1 AND expires_at<now() AND encrypted_token IS NOT NULL`,
          [t],
        );
      }, env);
    } catch {
      logger.error(
        JSON.stringify({ event: "whatsapp_activation_tick_failed" }),
      );
    } finally {
      if (!stopped) {
        timer = setTimeout(run, intervalMs);
        timer.unref?.();
      }
    }
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export async function captureSync(profile, changes, env = process.env) {
  if (!profile.coexistence || !changes.length) return;
  if (
    profile.customerId !== env.WHATSAPP_SIGNUP_CUSTOMER_ID ||
    profile.id !== connectionProfileId(env)
  )
    throw fail("Invalid connection scope.", 400);
  await connectionScope(async (db, tenant) => {
    const { createHash } = await import("node:crypto");
    for (const c of changes) {
      if (
        !c.value ||
        typeof c.value !== "object" ||
        (c.field === "history" &&
          !Array.isArray(c.value.history) &&
          !Array.isArray(c.value.messages)) ||
        (c.field === "smb_app_state_sync" && !Array.isArray(c.value.state_sync))
      )
        throw fail("Invalid synchronization payload.", 400);
      const digest = createHash("sha256")
        .update(JSON.stringify(c))
        .digest("hex");
      const key = Buffer.from(env.WHATSAPP_SIGNUP_ENCRYPTION_KEY, "base64");
      await db.query(
        `INSERT INTO ${s}.whatsapp_sync_receipts(customer_id,receipt_key,field,encrypted_payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
        [
          tenant,
          digest,
          c.field,
          JSON.stringify(
            seal(JSON.stringify(c.value), key, `${tenant}:${digest}`),
          ),
        ],
      );
      if (
        c.field === "account_update" &&
        ["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"].includes(c.value?.event)
      ) {
        await db.query(
          `UPDATE ${s}.whatsapp_connections SET state='disconnected',encrypted_token=NULL,failure_code='meta_disconnected',updated_at=now() WHERE customer_id=$1`,
          [tenant],
        );
        await db.query(
          `UPDATE ${s}.assistant_channels SET enabled=false,revision=revision+1 WHERE customer_id=$1 AND profile_id=$2 AND enabled`,
          [tenant, profile.id],
        );
      }
    }
  }, env);
}
export async function processSyncReceipt({
  env = process.env,
  scope = (work) => connectionScope(work, env),
} = {}) {
  return scope(async (db, tenant) => {
    const r = (
      await db.query(
        `SELECT * FROM ${s}.whatsapp_sync_receipts WHERE customer_id=$1 AND processed_at IS NULL ORDER BY received_at,receipt_key FOR UPDATE SKIP LOCKED LIMIT 1`,
        [tenant],
      )
    ).rows[0];
    if (!r) return { processed: false };
    const v = JSON.parse(
      unseal(
        r.encrypted_payload,
        Buffer.from(env.WHATSAPP_SIGNUP_ENCRYPTION_KEY, "base64"),
        `${tenant}:${r.receipt_key}`,
      ),
    );
    const touched = new Set();
    const flush = async () => {
      if (!touched.size) return;
      const channel = (
        await db.query(
          `SELECT channel_id FROM ${s}.assistant_channels WHERE customer_id=$1 AND profile_id=$2`,
          [tenant, connectionProfileId(env)],
        )
      ).rows[0];
      if (channel)
        for (const contact of touched)
          await attachImportedHistory(db, tenant, channel.channel_id, contact);
    };
    let seen = 0,
      processed = 0,
      progressToApply = 0;
    const nextItem = async () => {
      if (seen++ < r.processed_items) return false;
      if (processed++ < 500) return true;
      await db.query(
        `UPDATE ${s}.whatsapp_sync_receipts SET processed_items=$3 WHERE customer_id=$1 AND receipt_key=$2`,
        [tenant, r.receipt_key, r.processed_items + 500],
      );
      return null;
    };
    if (r.field === "history") {
      for (const h of v.history ?? []) {
        if (h.errors?.some((e) => e.code === 2593109))
          await db.query(
            `UPDATE ${s}.whatsapp_connections SET history_declined=true WHERE customer_id=$1`,
            [tenant],
          );
        else if (h.errors?.length)
          await db.query(
            `UPDATE ${s}.whatsapp_connections SET state='attention',failure_code='history_sync_failed' WHERE customer_id=$1`,
            [tenant],
          );
        const progress = h.metadata?.progress;
        if (Number.isInteger(progress) && progress >= 0 && progress <= 100)
          progressToApply = Math.max(progressToApply, progress);
        const conn = (
          await db.query(
            `SELECT display_phone_number FROM ${s}.whatsapp_connections WHERE customer_id=$1`,
            [tenant],
          )
        ).rows[0];
        const own = conn.display_phone_number.replace(/\D/g, "");
        for (const thread of h.threads ?? []) {
          const contact =
            thread.id ?? thread.context?.wa_id ?? thread.context?.user_id;
          if (typeof contact !== "string" || contact.length > 200) continue;
          for (const m of thread.messages ?? []) {
            const process = await nextItem();
            if (process === null) {
              await flush();
              return { processed: true };
            }
            if (!process) continue;
            const ms = Number(m.timestamp) * 1000;
            if (
              typeof m.id !== "string" ||
              m.id.length > 300 ||
              !Number.isFinite(ms) ||
              ms < 946684800000 ||
              ms > Date.now() + 300000
            )
              continue;
            await db.query(
              `INSERT INTO ${s}.whatsapp_imported_messages(customer_id,message_id,contact_key,sent_at,direction,message_type,body) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [
                tenant,
                m.id,
                contact,
                new Date(ms),
                String(m.from).replace(/\D/g, "") === own
                  ? "outbound"
                  : "inbound",
                String(m.type ?? "unsupported").slice(0, 40),
                String(m.text?.body ?? "")
                  .replaceAll("\u0000", "")
                  .slice(0, 4000),
              ],
            );
            touched.add(contact);
          }
        }
      }
    }
    if (r.field === "smb_app_state_sync") {
      for (const item of v.state_sync ?? []) {
        const process = await nextItem();
        if (process === null) {
          await flush();
          return { processed: true };
        }
        if (!process) continue;
        if (item.type !== "contact") continue;
        const c = item.contact,
          id = c?.phone_number ?? c?.user_id,
          ms = Number(item.metadata?.timestamp) * 1000;
        if (
          typeof id !== "string" ||
          id.length > 200 ||
          !Number.isFinite(ms) ||
          ms < 946684800000 ||
          ms > Date.now() + 300000
        )
          continue;
        await db.query(
          `INSERT INTO ${s}.whatsapp_imported_contacts(customer_id,contact_key,display_name,phone,changed_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(customer_id,contact_key) DO UPDATE SET display_name=EXCLUDED.display_name,phone=EXCLUDED.phone,changed_at=EXCLUDED.changed_at WHERE whatsapp_imported_contacts.changed_at<=EXCLUDED.changed_at`,
          [
            tenant,
            id,
            item.action === "remove"
              ? ""
              : String(c.full_name ?? c.first_name ?? "")
                  .replaceAll("\u0000", "")
                  .slice(0, 160),
            item.action === "remove" ? null : (c.phone_number ?? null),
            new Date(ms),
          ],
        );
      }
      await db.query(
        `UPDATE ${s}.whatsapp_connections SET contacts_received=true WHERE customer_id=$1`,
        [tenant],
      );
    }
    await flush();
    if (progressToApply)
      await db.query(
        `UPDATE ${s}.whatsapp_connections SET history_progress=GREATEST(history_progress,$2) WHERE customer_id=$1`,
        [tenant, progressToApply],
      );
    await db.query(
      `UPDATE ${s}.whatsapp_sync_receipts SET processed_at=now() WHERE customer_id=$1 AND receipt_key=$2`,
      [tenant, r.receipt_key],
    );
    await readyConnection(db, tenant, env.WHATSAPP_SIGNUP_BASE_PROFILE);
    return { processed: true };
  });
}

export async function attachImportedHistory(db, tenant, channelId, senderId) {
  await db.query(
    `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,kind,body,metadata,created_at)
 SELECT $1,c.conversation_id,CASE WHEN m.direction='inbound' THEN 'inbound_message' ELSE 'outbound_message' END,m.body,jsonb_build_object('importedMessageId',m.message_id,'imported',true,'messageType','history','sentAt',m.sent_at),m.sent_at
 FROM (SELECT * FROM ${s}.whatsapp_imported_messages WHERE customer_id=$1 AND contact_key=$3 ORDER BY sent_at DESC,message_id LIMIT 500) m
 JOIN ${s}.assistant_channel_contacts t ON t.customer_id=m.customer_id AND t.channel_id=$2 AND t.sender_id=m.contact_key
 JOIN ${s}.assistant_lead_conversations c ON c.customer_id=t.customer_id AND c.lead_id=t.lead_id
 ORDER BY m.sent_at,m.message_id ON CONFLICT DO NOTHING`,
    [tenant, channelId, senderId],
  );
}
