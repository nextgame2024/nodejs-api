import pool from "../../config/db.js";
import { randomUUID } from "node:crypto";
import { transaction, directory } from "../leads/assistant-settings.service.js";
import { fail, revision } from "../leads/assistant-settings.contracts.js";
import { channelProfiles } from "./channel-profiles.js";
const s = "sophia_runtime";
async function installed(db) {
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.assistant_channels') IS NOT NULL AS ready",
      )
    ).rows[0].ready
  )
    throw fail(
      "WhatsApp receiving is not available yet. Contact your administrator to finish setup.",
      503,
    );
}
export async function channelStatus(actor, company) {
  return transaction(actor, company, async (db, tenant) => {
    await installed(db);
    const channels = (
      await db.query(
        `SELECT channel_id AS "channelId",profile_id AS "profileId",enabled,revision,last_received_at AS "lastReceivedAt" FROM ${s}.assistant_channels WHERE customer_id=$1 ORDER BY profile_id`,
        [tenant],
      )
    ).rows;
    const profiles = channelProfiles()
      .filter((p) => p.customerId === tenant)
      .map((p) => ({ id: p.id, label: p.label, ready: p.ready }));
    const health = (
      await db.query(
        `SELECT count(*) FILTER(WHERE state='queued')::int AS queued,count(*) FILTER(WHERE state='failed')::int AS failed,min(received_at) FILTER(WHERE state='queued') AS "oldestQueuedAt" FROM ${s}.assistant_channel_receipts WHERE customer_id=$1 AND state IN ('queued','failed')`,
        [tenant],
      )
    ).rows[0];
    return { profiles, channels, health, mode: "receive_only" };
  });
}
export async function configureChannel(actor, company, input) {
  const expected = revision(input?.expectedRevision);
  if (
    typeof input?.enabled !== "boolean" ||
    typeof input?.profileId !== "string" ||
    Object.keys(input).some(
      (k) => !["profileId", "enabled", "expectedRevision"].includes(k),
    )
  )
    throw fail("Select a valid receiving connection.");
  return transaction(actor, company, async (db, tenant) => {
    await installed(db);
    const p = channelProfiles().find(
      (p) => p.customerId === tenant && p.id === input.profileId,
    );
    if (!p || (!p.ready && input.enabled))
      throw fail(
        "This receiving connection is not ready. Contact your administrator.",
        409,
      );
    if (
      input.enabled &&
      !(
        await db.query(
          `SELECT 1 FROM ${s}.lead_assistant_setting_releases WHERE customer_id=$1 LIMIT 1`,
          [tenant],
        )
      ).rows.length
    )
      throw fail("Publish assistant Settings before enabling receiving.", 409);
    let row;
    if (expected === 0)
      row = (
        await db.query(
          `INSERT INTO ${s}.assistant_channels(customer_id,profile_id,phone_number_id,business_account_id,enabled,updated_by_identity) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(customer_id,profile_id) DO NOTHING RETURNING revision`,
          [
            tenant,
            p.id,
            p.phoneNumberId,
            p.businessAccountId,
            input.enabled,
            actor,
          ],
        )
      ).rows[0];
    else
      row = (
        await db.query(
          `UPDATE ${s}.assistant_channels SET enabled=$3,revision=revision+1,updated_by_identity=$4,updated_at=now() WHERE customer_id=$1 AND profile_id=$2 AND revision=$5 AND phone_number_id=$6 AND business_account_id=$7 RETURNING revision`,
          [
            tenant,
            p.id,
            input.enabled,
            actor,
            expected,
            p.phoneNumberId,
            p.businessAccountId,
          ],
        )
      ).rows[0];
    if (!row)
      throw fail(
        "Connection settings changed. Refresh and review before saving.",
        409,
      );
    await db.query(
      `INSERT INTO ${s}.lead_assistant_settings_audit(customer_id,actor_identity,action,revision) VALUES($1,$2,'channel_updated',$3)`,
      [tenant, actor, row.revision],
    );
    return { revision: row.revision, enabled: input.enabled };
  });
}
// Profile is resolved exclusively from the deployment allowlist after signature
// verification. All message/queue operations remain under the Runtime app role.
async function scoped(profile, work) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE sophia_runtime_app");
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
      profile.customerId,
    ]);
    const customer = (
      await db.query(
        `SELECT external_company_id FROM ${s}.customers WHERE customer_id=$1 AND status='active'`,
        [profile.customerId],
      )
    ).rows[0];
    if (!customer) throw fail("Receiving connection unavailable.", 503);
    await installed(db);
    const channel = (
      await db.query(
        `SELECT * FROM ${s}.assistant_channels WHERE customer_id=$1 AND profile_id=$2 AND phone_number_id=$3 AND business_account_id=$4 AND enabled FOR SHARE`,
        [
          profile.customerId,
          profile.id,
          profile.phoneNumberId,
          profile.businessAccountId,
        ],
      )
    ).rows[0];
    if (!channel) throw fail("Receiving connection unavailable.", 503);
    const value = await work(db, channel, customer.external_company_id);
    await db.query("COMMIT");
    return value;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function receiveEvents(profile, events) {
  return scoped(profile, async (db, channel) => {
    const result = await db.query(
      `INSERT INTO ${s}.assistant_channel_receipts(customer_id,channel_id,event_key,event)
       SELECT $1,$2,item->>'key',item FROM jsonb_array_elements($3::jsonb) item
       ON CONFLICT(customer_id,channel_id,event_key) DO NOTHING`,
      [profile.customerId, channel.channel_id, JSON.stringify(events)],
    );
    const inserted = result.rowCount;
    await db.query(
      `UPDATE ${s}.assistant_channels SET last_received_at=now() WHERE customer_id=$1 AND channel_id=$2`,
      [profile.customerId, channel.channel_id],
    );
    return { inserted };
  });
}
const optOut = (text) =>
  [
    "stop",
    "unsubscribe",
    "cancelar",
    "parar",
    "salir",
    "baja",
    "no mas mensajes",
    "não quero mensagens",
    "nao quero mensagens",
  ].includes(text.trim().toLowerCase().replace(/[.!]$/, ""));
async function applyMessage(db, profile, channel, company, e) {
  const tenant = profile.customerId;
  // Serializes the same channel/sender across workers; no network work in lock.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${tenant}:${channel.channel_id}:${e.senderId}`,
  ]);
  let contact = (
    await db.query(
      `SELECT * FROM ${s}.assistant_channel_contacts WHERE customer_id=$1 AND channel_id=$2 AND sender_id=$3 FOR UPDATE`,
      [tenant, channel.channel_id, e.senderId],
    )
  ).rows[0];
  if (!contact) {
    const release = (
      await db.query(
        `SELECT release_id,configuration FROM ${s}.lead_assistant_setting_releases WHERE customer_id=$1 ORDER BY source_revision DESC LIMIT 1`,
        [tenant],
      )
    ).rows[0];
    if (!release) throw fail("Configuration required.", 409);
    const c = release.configuration;
    const ids = [
      ...new Set([c.enquiryOwnerId, c.fallbackOwnerId].filter(Boolean)),
    ];
    const staff = ids.length ? await directory(db, company, { ids }) : [];
    const assignee = ids.find((id) => staff.some((u) => u.id === id)) ?? null;
    const id = randomUUID();
    await db.query(
      `INSERT INTO ${s}.assistant_leads(lead_id,customer_id,display_name,phone,language,assigned_to_identity,settings_release_id,source,request_key,request_hash,created_by_identity) VALUES($1,$2,$3,$4,$5,$6,$7,'whatsapp',$8,'channel_inbound','whatsapp')`,
      [
        id,
        tenant,
        e.displayName || `WhatsApp enquiry • ${e.senderId.slice(-4)}`,
        e.senderId,
        c.defaultLanguage,
        assignee,
        release.release_id,
        randomUUID(),
      ],
    );
    await db.query(
      `INSERT INTO ${s}.assistant_lead_conversations(customer_id,lead_id,ownership) VALUES($1,$2,'human_requested')`,
      [tenant, id],
    );
    await db.query(
      `INSERT INTO ${s}.assistant_channel_contacts(customer_id,channel_id,sender_id,lead_id) VALUES($1,$2,$3,$4)`,
      [tenant, channel.channel_id, e.senderId, id],
    );
    contact = { lead_id: id };
  }
  // Same lead lock order as staff mutations, preventing deadlocks with takeover.
  await db.query(
    `SELECT lead_id FROM ${s}.assistant_leads WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
    [tenant, contact.lead_id],
  );
  const conversation = (
    await db.query(
      `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
      [tenant, contact.lead_id],
    )
  ).rows[0];
  const echo = e.kind === "app_echo",
    stop = !echo && e.messageType === "text" && optOut(e.body);
  if (echo || stop) {
    await db.query(
      `UPDATE ${s}.assistant_lead_conversations SET ownership='paused',human_owner_identity=NULL,ownership_version=ownership_version+1,updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
      [tenant, contact.lead_id],
    );
  }
  if (!echo)
    await db.query(
      `UPDATE ${s}.assistant_channel_contacts SET last_inbound_at=GREATEST(last_inbound_at,$4::timestamptz),opted_out=opted_out OR $5 WHERE customer_id=$1 AND channel_id=$2 AND sender_id=$3`,
      [tenant, channel.channel_id, e.senderId, e.sentAt, stop],
    );
  const body =
    e.messageType === "text"
      ? e.body
      : `[${echo ? "Sent" : "Received"} ${e.media?.voice ? "voice" : e.messageType} message — open WhatsApp to review]`;
  await db.query(
    `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,kind,body,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [
      tenant,
      conversation.conversation_id,
      echo ? "outbound_message" : "inbound_message",
      body,
      JSON.stringify({
        channel: "whatsapp",
        origin: echo ? "business_app" : "customer",
        messageId: e.messageId,
        sentAt: e.sentAt,
        messageType: e.messageType,
        truncated: !!e.truncated,
        ...(e.media ? { media: e.media } : {}),
        optedOut: stop,
      }),
    ],
  );
  await db.query(
    `UPDATE ${s}.assistant_leads SET updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
    [tenant, contact.lead_id],
  );
}
export async function processChannelEvent(profile) {
  return scoped(profile, async (db, channel, company) => {
    const receipt = (
      await db.query(
        `SELECT * FROM ${s}.assistant_channel_receipts WHERE customer_id=$1 AND channel_id=$2 AND state='queued' AND available_at<=now() ORDER BY receipt_id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [profile.customerId, channel.channel_id],
      )
    ).rows[0];
    if (!receipt) return { processed: false };
    await db.query("SAVEPOINT message_work");
    try {
      if (["inbound", "app_echo"].includes(receipt.event.kind))
        await applyMessage(db, profile, channel, company, receipt.event);
      await db.query(
        `UPDATE ${s}.assistant_channel_receipts SET state='processed',attempts=attempts+1,processed_at=now(),event=$3::jsonb,failure_code=NULL WHERE customer_id=$1 AND receipt_id=$2`,
        [
          profile.customerId,
          receipt.receipt_id,
          JSON.stringify({
            kind: receipt.event.kind,
            messageId: receipt.event.messageId,
            status: receipt.event.status,
            field: receipt.event.field,
          }),
        ],
      );
      return { processed: true };
    } catch (e) {
      await db.query("ROLLBACK TO SAVEPOINT message_work");
      const attempt = receipt.attempts + 1;
      await db.query(
        `UPDATE ${s}.assistant_channel_receipts SET state=$3,attempts=$4,available_at=now()+($5::int*interval '1 second'),failure_code=$6 WHERE customer_id=$1 AND receipt_id=$2`,
        [
          profile.customerId,
          receipt.receipt_id,
          attempt >= 8 ? "failed" : "queued",
          attempt,
          Math.min(900, 2 ** attempt * 5),
          e.status === 409 ? "configuration_required" : "processing_failed",
        ],
      );
      return { processed: false, retry: true, failed: attempt >= 8 };
    }
  });
}
