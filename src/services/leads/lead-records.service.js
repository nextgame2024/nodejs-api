import {
  replyState,
  automationTarget,
  enqueueAutomatic,
} from "../messaging/reply-store.js";
import { transaction, directory } from "./assistant-settings.service.js";
import { fail } from "./assistant-settings.contracts.js";
import {
  leadInput,
  listQuery,
  uuid,
  version,
  text,
  hash,
  cursor,
} from "./lead-records.contracts.js";
const s = "sophia_runtime";
const visible = "( $2::boolean OR l.assigned_to_identity=$3 )";
const detailFields = `l.lead_id AS "leadId",l.display_name AS "displayName",l.email,l.phone,l.language,l.interest,l.location,l.timeframe,l.stage,l.stage_reason AS "stageReason",l.assigned_to_identity AS "assignedTo",l.record_version AS version,l.source,l.created_at AS "createdAt",l.updated_at AS "updatedAt",c.conversation_id AS "conversationId",c.ownership,c.human_owner_identity AS "humanOwner",c.ownership_version AS "ownershipVersion"`;
async function run(actor, company, fn) {
  return transaction(
    actor,
    company,
    async (db, tenant, access) => {
      if (
        !(
          await db.query(
            "SELECT to_regclass('sophia_runtime.assistant_leads') IS NOT NULL AS installed",
          )
        ).rows[0].installed
      )
        throw fail(
          "The enquiries inbox is not available yet. Contact your administrator to finish setup.",
          503,
        );
      return fn(db, tenant, access);
    },
    { inbox: true },
  );
}
function teamIds(access) {
  const c = access.published?.configuration;
  return [
    ...new Set(
      [c?.enquiryOwnerId, c?.fallbackOwnerId, ...(c?.advisorIds ?? [])].filter(
        Boolean,
      ),
    ),
  ];
}
async function team(db, company, access) {
  const ids = teamIds(access);
  return ids.length ? directory(db, company, { ids }) : [];
}
export async function requiredLead(db, tenant, access, id, lock = false) {
  const row = (
    await db.query(
      `SELECT l.* FROM ${s}.assistant_leads l WHERE l.customer_id=$1 AND ${visible} AND l.lead_id=$4 ${lock ? "FOR UPDATE" : ""}`,
      [tenant, access.canManageLeads, access.actor, id],
    )
  ).rows[0];
  if (!row) throw fail("Lead not found or no longer assigned to you.", 404);
  return row;
}
async function events(db, tenant, conversationId, before = null) {
  const rows = (
    await db.query(
      `SELECT event_id::text AS id,kind,body,actor_identity AS "actorId",metadata,created_at AS "createdAt" FROM ${s}.assistant_lead_events WHERE customer_id=$1 AND conversation_id=$2 AND ($3::bigint IS NULL OR event_id<$3) ORDER BY event_id DESC LIMIT 51`,
      [tenant, conversationId, before],
    )
  ).rows;
  return { events: rows.slice(0, 50).reverse(), hasOlder: rows.length > 50 };
}
export async function detail(db, tenant, access, id) {
  const row = (
    await db.query(
      `SELECT ${detailFields} FROM ${s}.assistant_leads l JOIN ${s}.assistant_lead_conversations c ON c.customer_id=l.customer_id AND c.lead_id=l.lead_id WHERE l.customer_id=$1 AND ${visible} AND l.lead_id=$4`,
      [tenant, access.canManageLeads, access.actor, id],
    )
  ).rows[0];
  if (!row) throw fail("Lead not found or no longer assigned to you.", 404);
  return {
    lead: row,
    ...(await events(db, tenant, row.conversationId)),
    reply: await replyState(db, tenant, access, id),
  };
}
async function event(db, tenant, conversationId, actor, kind, metadata = {}) {
  await db.query(
    `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,actor_identity,kind,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [tenant, conversationId, actor, kind, JSON.stringify(metadata)],
  );
}
async function eligibleAssignee(db, company, access, id) {
  if (!id) return;
  if (
    !teamIds(access).includes(id) ||
    (await directory(db, company, { ids: [id] })).length !== 1
  )
    throw fail(
      "Select an active advisor or owner from the published team.",
      400,
      ["assignedTo"],
    );
}
export async function inboxContext(actor, company) {
  return run(actor, company, async (db, tenant, access) => {
    const staff = await team(db, company, access);
    const c = access.published?.configuration;
    const defaultAssigneeId = access.canManageLeads
      ? ([c?.enquiryOwnerId, c?.fallbackOwnerId].find((id) =>
          staff.some((u) => u.id === id),
        ) ?? null)
      : actor;
    return {
      actorId: actor,
      canManageSettings: access.manager,
      canManageLeads: access.canManageLeads,
      canCreate: !!access.published,
      defaultLanguage: c?.defaultLanguage ?? "es",
      languages: c?.languages ?? ["es"],
      defaultAssigneeId,
      staff,
      settingsPublished: !!access.published,
      transportReady: false,
    };
  });
}
export async function listLeads(actor, company, query) {
  const f = listQuery(query);
  return run(actor, company, async (db, tenant, access) => {
    const column = {
      name: "lower(display_name)",
      updated: "updated_at",
      stage: "stage",
    }[f.sort];
    const out = {
      name: 'lower("displayName")',
      updated: '"updatedAt"',
      stage: "stage",
    }[f.sort];
    const direction = f.direction.toUpperCase();
    const result = (
      await db.query(
        `WITH filtered AS (
  SELECT l.*,c.conversation_id,c.ownership,c.human_owner_identity FROM ${s}.assistant_leads l JOIN ${s}.assistant_lead_conversations c ON c.customer_id=l.customer_id AND c.lead_id=l.lead_id
  WHERE l.customer_id=$1 AND ${visible} AND ($4='' OR l.stage=$4) AND ($5='' OR l.display_name ILIKE $5 OR l.interest ILIKE $5)
   AND ($6::text IS NULL OR l.assigned_to_identity=$6) AND ($7='' OR c.ownership=$7)
 ), page_rows AS (SELECT lead_id AS "leadId",display_name AS "displayName",language,interest,stage,assigned_to_identity AS "assignedTo",record_version AS version,source,updated_at AS "updatedAt",conversation_id AS "conversationId",ownership,human_owner_identity AS "humanOwner" FROM filtered ORDER BY ${column} ${direction},lead_id LIMIT $8 OFFSET $9)
 SELECT (SELECT count(*)::int FROM filtered) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY ${out} ${direction},"leadId") FROM page_rows),'[]'::jsonb) AS items`,
        [
          tenant,
          access.canManageLeads,
          actor,
          f.stage,
          f.q ? `%${f.q.replace(/[\\%_]/g, "\\$&")}%` : "",
          f.assignedTo,
          f.ownership,
          f.limit,
          (f.page - 1) * f.limit,
        ],
      )
    ).rows[0];
    return { ...result, page: f.page, limit: f.limit };
  });
}
export async function getLead(actor, company, id) {
  uuid(id);
  return run(actor, company, (db, tenant, access) =>
    detail(db, tenant, access, id),
  );
}
export async function olderEvents(actor, company, id, before) {
  uuid(id);
  const value = cursor(before);
  return run(actor, company, async (db, tenant, access) => {
    await requiredLead(db, tenant, access, id);
    const c = (
      await db.query(
        `SELECT conversation_id FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2`,
        [tenant, id],
      )
    ).rows[0];
    return events(db, tenant, c.conversation_id, value);
  });
}
export async function createLead(actor, company, input) {
  const key = uuid(input?.requestKey);
  return run(actor, company, async (db, tenant, access) => {
    if (!access.published)
      throw fail("Publish assistant Settings before creating leads.", 409);
    const config = access.published.configuration;
    const supplied = input?.lead;
    let defaultAssignee = actor;
    if (access.canManageLeads) {
      const staff = await team(db, company, access);
      defaultAssignee =
        [config.enquiryOwnerId, config.fallbackOwnerId].find((id) =>
          staff.some((u) => u.id === id),
        ) ?? null;
    }
    const c = leadInput({
      ...supplied,
      language: supplied?.language ?? config.defaultLanguage,
      assignedTo:
        supplied && Object.hasOwn(supplied, "assignedTo")
          ? supplied.assignedTo
          : defaultAssignee,
    });
    if (c.stage !== "new")
      throw fail("Create a new lead before updating its stage.");
    if (!access.published.configuration.languages.includes(c.language))
      throw fail("Select a language enabled in Settings.", 400, ["language"]);
    if (!access.canManageLeads && c.assignedTo !== actor)
      throw fail("You can only create leads assigned to yourself.", 403);
    await eligibleAssignee(db, company, access, c.assignedTo);
    const fingerprint = hash(c);
    const inserted = (
      await db.query(
        `INSERT INTO ${s}.assistant_leads(customer_id,display_name,email,phone,language,interest,location,timeframe,assigned_to_identity,settings_release_id,request_key,request_hash,created_by_identity)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(customer_id,request_key) DO NOTHING RETURNING lead_id`,
        [
          tenant,
          c.displayName,
          c.email,
          c.phone,
          c.language,
          c.interest,
          c.location,
          c.timeframe,
          c.assignedTo,
          access.published.release_id,
          key,
          fingerprint,
          actor,
        ],
      )
    ).rows[0];
    if (!inserted) {
      const old = (
        await db.query(
          `SELECT lead_id,request_hash,created_by_identity FROM ${s}.assistant_leads WHERE customer_id=$1 AND request_key=$2`,
          [tenant, key],
        )
      ).rows[0];
      if (
        !old ||
        old.request_hash !== fingerprint ||
        old.created_by_identity !== actor
      )
        throw fail(
          "This submission key was already used. Start a new lead.",
          409,
        );
      return detail(db, tenant, access, old.lead_id);
    }
    const conversation = (
      await db.query(
        `INSERT INTO ${s}.assistant_lead_conversations(customer_id,lead_id) VALUES($1,$2) RETURNING conversation_id`,
        [tenant, inserted.lead_id],
      )
    ).rows[0];
    await event(
      db,
      tenant,
      conversation.conversation_id,
      actor,
      "lead_created",
      {
        source: "manual",
        factsSource: "staff_entry",
        settingsReleaseId: access.published.release_id,
      },
    );
    return detail(db, tenant, access, inserted.lead_id);
  });
}
export async function updateLead(actor, company, id, input) {
  uuid(id);
  const expected = version(input?.expectedVersion),
    c = leadInput(input?.lead);
  return run(actor, company, async (db, tenant, access) => {
    const old = await requiredLead(db, tenant, access, id, true);
    if (old.record_version !== expected)
      throw fail("This lead changed. Reload it before saving.", 409);
    if (!access.canManageLeads && c.assignedTo !== old.assigned_to_identity)
      throw fail("Only the enquiry owner can reassign a lead.", 403);
    if (
      access.published &&
      !access.published.configuration.languages.includes(c.language)
    )
      throw fail("Select a language enabled in Settings.", 400, ["language"]);
    await eligibleAssignee(db, company, access, c.assignedTo);
    await db.query(
      `UPDATE ${s}.assistant_leads SET display_name=$3,email=$4,phone=$5,language=$6,interest=$7,location=$8,timeframe=$9,stage=$10,stage_reason=$11,assigned_to_identity=$12,record_version=record_version+1,updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
      [
        tenant,
        id,
        c.displayName,
        c.email,
        c.phone,
        c.language,
        c.interest,
        c.location,
        c.timeframe,
        c.stage,
        c.stageReason,
        c.assignedTo,
      ],
    );
    const conversation = (
      await db.query(
        `SELECT conversation_id FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
        [tenant, id],
      )
    ).rows[0];
    const assignmentChanged = old.assigned_to_identity !== c.assignedTo;
    if (assignmentChanged || c.stage === "closed")
      await db.query(
        `UPDATE ${s}.assistant_lead_conversations SET ownership='paused',human_owner_identity=NULL,ownership_version=ownership_version+1,updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
        [tenant, id],
      );
    if (assignmentChanged)
      await event(
        db,
        tenant,
        conversation.conversation_id,
        actor,
        "assignment_changed",
        {
          previousAssignee: old.assigned_to_identity,
          assignedTo: c.assignedTo,
          automationPaused: true,
        },
      );
    const fieldColumns = {
      displayName: "display_name",
      email: "email",
      phone: "phone",
      language: "language",
      interest: "interest",
      location: "location",
      timeframe: "timeframe",
      stage: "stage",
      stageReason: "stage_reason",
      assignedTo: "assigned_to_identity",
    };
    const changedFields = Object.entries(fieldColumns)
      .filter(([key, column]) => old[column] !== c[key])
      .map(([key]) => key);
    await event(
      db,
      tenant,
      conversation.conversation_id,
      actor,
      "lead_updated",
      {
        factsSource: "staff_entry",
        changedFields,
        previousStage: old.stage,
        stage: c.stage,
        stageReason: c.stageReason,
      },
    );
    return detail(db, tenant, access, id);
  });
}
export async function addNote(actor, company, id, input) {
  uuid(id);
  const key = uuid(input?.requestKey),
    body = text(input?.body, "note", 4000, true);
  return run(actor, company, async (db, tenant, access) => {
    await requiredLead(db, tenant, access, id, true);
    const c = (
      await db.query(
        `SELECT conversation_id FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2`,
        [tenant, id],
      )
    ).rows[0];
    const fingerprint = hash({ body });
    const inserted = await db.query(
      `INSERT INTO ${s}.assistant_lead_events(customer_id,conversation_id,actor_identity,kind,body,request_key,request_hash) VALUES($1,$2,$3,'note',$4,$5,$6) ON CONFLICT(customer_id,conversation_id,request_key) DO NOTHING RETURNING event_id`,
      [tenant, c.conversation_id, actor, body, key, fingerprint],
    );
    if (!inserted.rowCount) {
      const old = (
        await db.query(
          `SELECT actor_identity,request_hash FROM ${s}.assistant_lead_events WHERE customer_id=$1 AND conversation_id=$2 AND request_key=$3`,
          [tenant, c.conversation_id, key],
        )
      ).rows[0];
      if (old.actor_identity !== actor || old.request_hash !== fingerprint)
        throw fail("This note key was already used. Start a new note.", 409);
    } else
      await db.query(
        `UPDATE ${s}.assistant_leads SET updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
        [tenant, id],
      );
    return detail(db, tenant, access, id);
  });
}
export async function changeOwnership(actor, company, id, input) {
  uuid(id);
  const expected = version(input?.expectedVersion),
    ownership = input?.ownership;
  if (!["human", "paused", "bot"].includes(ownership))
    throw fail("Automated replies are not connected yet.");
  return run(actor, company, async (db, tenant, access) => {
    const lead = await requiredLead(db, tenant, access, id, true);
    if (lead.stage === "closed" && ownership === "human")
      throw fail("Reopen the lead before taking over the conversation.", 409);
    const c = (
      await db.query(
        `SELECT * FROM ${s}.assistant_lead_conversations WHERE customer_id=$1 AND lead_id=$2 FOR UPDATE`,
        [tenant, id],
      )
    ).rows[0];
    if (c.ownership_version !== expected)
      throw fail(
        "Conversation ownership changed. Reload before continuing.",
        409,
      );
    if (
      c.human_owner_identity &&
      c.human_owner_identity !== actor &&
      !access.canManageLeads
    )
      throw fail(
        "Another team member is handling this conversation. Ask the enquiry owner to transfer it.",
        409,
      );
    const target =
      ownership === "bot" ? await automationTarget(db, tenant, id) : null;
    if (ownership === "bot" && !target)
      throw fail(
        "Automatic replies are not configured or this conversation is not eligible.",
        409,
      );
    await db.query(
      `UPDATE ${s}.assistant_lead_conversations SET ownership=$3,human_owner_identity=$4,ownership_version=ownership_version+1,updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
      [tenant, id, ownership, ownership === "human" ? actor : null],
    );
    await db.query(
      `UPDATE ${s}.assistant_leads SET updated_at=now() WHERE customer_id=$1 AND lead_id=$2`,
      [tenant, id],
    );
    if (target)
      await enqueueAutomatic(db, target.profile, id, target.eventId, false);
    await event(db, tenant, c.conversation_id, actor, "ownership_changed", {
      previousOwnership: c.ownership,
      ownership,
      previousOwner: c.human_owner_identity,
    });
    return detail(db, tenant, access, id);
  });
}
