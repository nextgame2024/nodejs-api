import pool from "../../config/db.js";
import {
  configuration,
  defaults,
  fail,
  publicationIssues,
  revision,
  selectedIds,
} from "./assistant-settings.contracts.js";
const schema = "sophia_runtime";
const managerSql = `SELECT EXISTS(SELECT 1 FROM sophia_runtime.admin_memberships
 WHERE customer_id=$1 AND identity_user_id=$2 AND status='active' AND role_key='organisation_owner')
 OR EXISTS(SELECT 1 FROM sophia_runtime.business_pack_entitlements
 WHERE customer_id=$1 AND identity_user_id=$2 AND status='active' AND pack_id='student-operations' AND role_key='chief_executive') AS allowed`;

// The identity pool resolves the signed-in company. All configuration reads and
// writes use the non-BYPASSRLS Runtime role, scoped to that verified customer.
export async function transaction(
  actor,
  company,
  work,
  { inbox = false } = {},
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const scopes = await db.query(
      `SELECT c.customer_id FROM public.users u JOIN public.bm_company b ON b.company_id=u.company_id
    JOIN sophia_runtime.customers c ON c.external_company_id=b.company_id::text AND c.status='active'
    WHERE u.id=$1 AND u.company_id=$2 AND u.status='active' AND u.type::text IN ('employee','advisor') AND b.status='active'`,
      [actor, company],
    );
    if (scopes.rows.length !== 1)
      throw fail("You do not have access to assistant settings.", 403);
    const tenant = scopes.rows[0].customer_id;
    await db.query("SET LOCAL ROLE sophia_runtime_app");
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [tenant]);
    const manager = !!(await db.query(managerSql, [tenant, actor])).rows[0]
      ?.allowed;
    if (!manager && !inbox)
      throw fail(
        "Only a business owner or Chief Executive can configure the assistant.",
        403,
      );
    if (
      !(
        await db.query(
          "SELECT to_regclass('sophia_runtime.lead_assistant_settings') IS NOT NULL AS installed",
        )
      ).rows[0].installed
    )
      throw fail(
        "Assistant settings are not available yet. Contact your administrator to finish setup.",
        503,
      );
    let access = { manager, canManageLeads: manager, actor, published: null };
    if (inbox) {
      const published =
        (
          await db.query(
            `SELECT release_id,configuration FROM ${schema}.lead_assistant_setting_releases WHERE customer_id=$1 ORDER BY source_revision DESC LIMIT 1`,
            [tenant],
          )
        ).rows[0] ?? null;
      const c = published?.configuration;
      const owners = [c?.enquiryOwnerId, c?.fallbackOwnerId].filter(Boolean);
      if (!manager && ![...owners, ...(c?.advisorIds ?? [])].includes(actor))
        throw fail("You do not have access to the enquiries inbox.", 403);
      access = {
        manager,
        canManageLeads: manager || owners.includes(actor),
        actor,
        published,
      };
    }
    const result = await work(db, tenant, access);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
// Identity-directory read only: fixed SQL, verified company, selected IDs or
// bounded search. No user credentials/emails are projected or changed.
export async function directory(db, company, { q = "", ids = [] } = {}) {
  await db.query("RESET ROLE");
  try {
    return (
      await db.query(
        `SELECT id,name FROM public.users WHERE company_id=$1 AND status='active'
  AND type::text IN ('employee','advisor') AND
  (id=ANY($3::uuid[]) OR (cardinality($3::uuid[])=0 AND name ILIKE $2))
  ORDER BY lower(name),id LIMIT $4`,
        [
          company,
          `%${q.replace(/[\\%_]/g, "\\$&")}%`,
          ids,
          ids.length ? 100 : 51,
        ],
      )
    ).rows;
  } finally {
    await db.query("SET LOCAL ROLE sophia_runtime_app");
  }
}
async function state(db, tenant) {
  const row = (
    await db.query(
      `SELECT
   (SELECT jsonb_build_object('revision',revision,'draft',draft,'updated_at',updated_at) FROM ${schema}.lead_assistant_settings WHERE customer_id=$1) AS draft,
   (SELECT to_jsonb(r) FROM (SELECT release_id,source_revision,configuration,published_at FROM ${schema}.lead_assistant_setting_releases WHERE customer_id=$1 ORDER BY source_revision DESC LIMIT 1) r) AS published`,
      [tenant],
    )
  ).rows[0];
  const draft = row.draft,
    published = row.published ?? null;
  return {
    revision: draft?.revision ?? 0,
    configuration: { ...defaults(), ...(draft?.draft ?? {}) },
    updatedAt: draft?.updated_at ?? null,
    published,
    connection: {
      status: "not_connected",
      numberUsage: "business_app",
      coexistenceVerified: false,
    },
    canManage: true,
  };
}
export async function getSettings(actor, company) {
  return transaction(actor, company, async (db, tenant) => {
    const result = await state(db, tenant);
    const chosen = selectedIds(result.configuration);
    const selected = chosen.length
      ? await directory(db, company, { ids: chosen })
      : [];
    const first = await directory(db, company);
    return {
      ...result,
      staff: [
        ...new Map(
          [...selected, ...first.slice(0, 50)].map((u) => [u.id, u]),
        ).values(),
      ],
      hasMoreStaff: first.length > 50,
      publicationIssues: publicationIssues(
        result.configuration,
        new Set(selected.map((u) => u.id)),
      ),
    };
  });
}
export async function searchStaff(actor, company, q) {
  if (typeof q !== "string" || q.length > 100)
    throw fail("Enter a shorter team search.");
  return transaction(actor, company, async (db) => {
    const rows = await directory(db, company, { q: q.trim() });
    return { staff: rows.slice(0, 50), hasMore: rows.length > 50 };
  });
}
async function validateTeam(db, company, c) {
  const ids = selectedIds(c);
  const rows = ids.length ? await directory(db, company, { ids }) : [];
  const eligible = new Set(rows.map((u) => u.id));
  if (ids.some((id) => !eligible.has(id)))
    throw fail(
      "One or more selected team members are inactive or unavailable. Select active staff from this company.",
      400,
      ["enquiryOwnerId", "contentOwnerId", "fallbackOwnerId", "advisorIds"],
    );
  return eligible;
}
export async function saveSettings(actor, company, input) {
  const expected = revision(input?.expectedRevision);
  const c = configuration(input?.configuration);
  return transaction(actor, company, async (db, tenant) => {
    await validateTeam(db, company, c);
    const saved =
      expected === 0
        ? (
            await db.query(
              `INSERT INTO ${schema}.lead_assistant_settings(customer_id,revision,draft,updated_by_identity)
        VALUES($1,1,$2::jsonb,$3) ON CONFLICT(customer_id) DO NOTHING RETURNING revision`,
              [tenant, JSON.stringify(c), actor],
            )
          ).rows[0]
        : (
            await db.query(
              `UPDATE ${schema}.lead_assistant_settings SET draft=$2::jsonb,revision=revision+1,
        updated_by_identity=$3,updated_at=now() WHERE customer_id=$1 AND revision=$4 RETURNING revision`,
              [tenant, JSON.stringify(c), actor, expected],
            )
          ).rows[0];
    if (!saved)
      throw fail(
        "Settings changed in another session. Refresh and review before saving.",
        409,
      );
    await db.query(
      `INSERT INTO ${schema}.lead_assistant_settings_audit(customer_id,actor_identity,action,revision) VALUES($1,$2,'draft_saved',$3)`,
      [tenant, actor, saved.revision],
    );
    return state(db, tenant);
  });
}
export async function publishSettings(actor, company, input) {
  const expected = revision(input?.expectedRevision);
  return transaction(actor, company, async (db, tenant) => {
    const row = (
      await db.query(
        `SELECT revision,draft FROM ${schema}.lead_assistant_settings WHERE customer_id=$1 FOR UPDATE`,
        [tenant],
      )
    ).rows[0];
    if (!row || row.revision !== expected)
      throw fail(
        "Settings changed. Refresh and save the draft before publishing.",
        409,
      );
    const eligible = await validateTeam(db, company, row.draft);
    const issues = publicationIssues(row.draft, eligible);
    if (issues.length)
      throw fail(
        "Complete business details, owners, advisors, greeting and coverage before publishing.",
        400,
        issues,
      );
    const inserted = await db.query(
      `INSERT INTO ${schema}.lead_assistant_setting_releases(customer_id,source_revision,configuration,published_by_identity)
    VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(customer_id,source_revision) DO NOTHING RETURNING release_id`,
      [tenant, expected, JSON.stringify(row.draft), actor],
    );
    if (inserted.rowCount)
      await db.query(
        `INSERT INTO ${schema}.lead_assistant_settings_audit(customer_id,actor_identity,action,revision) VALUES($1,$2,'published',$3)`,
        [tenant, actor, expected],
      );
    return state(db, tenant);
  });
}
export async function canManageSettings(actor, company) {
  try {
    await transaction(actor, company, async () => true);
    return true;
  } catch (e) {
    if ([403, 503].includes(e.status) || ["42P01", "42501"].includes(e.code))
      return false;
    throw e;
  }
}

export async function canAccessAssistant(actor, company) {
  try {
    await transaction(actor, company, async () => true, { inbox: true });
    return true;
  } catch (e) {
    if ([403, 503].includes(e.status) || ["42P01", "42501"].includes(e.code))
      return false;
    throw e;
  }
}
