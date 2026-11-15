import { transaction } from "./assistant-settings.service.js";
import { fail } from "./assistant-settings.contracts.js";
import { uuid, version, text } from "./lead-records.contracts.js";
import { formInput, formQuery } from "./lead-forms.contracts.js";
const s = "sophia_runtime";
export async function publicationsInstalled(db) {
  return (
    await db.query(
      "SELECT to_regclass('sophia_runtime.lead_form_publications') IS NOT NULL AS installed",
    )
  ).rows[0].installed;
}
export async function requirePublications(db) {
  if (!(await publicationsInstalled(db)))
    throw fail(
      "Form publishing is not available yet. Ask your administrator to finish the public forms database setup.",
      503,
    );
}
export async function requireFormEmailSetup(db) {
  if (
    !(
      await db.query(
        "SELECT to_regclass('sophia_runtime.lead_form_email_outbox') IS NOT NULL AS installed",
      )
    ).rows[0].installed
  )
    throw fail(
      "Form notification emails are not available yet. Ask your administrator to finish the public forms database setup.",
      503,
    );
}
export function formsTransaction(actor, company, work, write = false) {
  return transaction(
    actor,
    company,
    async (db, tenant, access) => {
      if (write && !access.canManageLeads)
        throw fail("Only lead managers can change forms and types.", 403);
      if (
        !(
          await db.query(
            "SELECT to_regclass('sophia_runtime.lead_forms') IS NOT NULL AS installed",
          )
        ).rows[0].installed
      )
        throw fail(
          "Forms are not available yet. Ask your administrator to finish setup.",
          503,
        );
      return work(db, tenant, access);
    },
    { inbox: true },
  );
}
async function audit(db, tenant, actor, id, action) {
  await db.query(
    `INSERT INTO ${s}.lead_forms_audit(customer_id,actor_identity,entity_id,action) VALUES($1,$2,$3,$4)`,
    [tenant, actor, id, action],
  );
}
export async function listTypes(actor, company) {
  return formsTransaction(actor, company, async (db, tenant) => {
    // Tombstones keep intentionally deleted defaults from being recreated.
    await db.query(
      `INSERT INTO ${s}.lead_form_types(customer_id,name) VALUES($1,'Technical'),($1,'Marketing') ON CONFLICT DO NOTHING`,
      [tenant],
    );
    return {
      items: (
        await db.query(
          `SELECT t.id,t.name,(SELECT count(*)::int FROM ${s}.lead_forms f WHERE f.customer_id=t.customer_id AND f.type_id=t.id) AS "formCount" FROM ${s}.lead_form_types t WHERE t.customer_id=$1 AND t.deleted_at IS NULL ORDER BY lower(t.name),t.id`,
          [tenant],
        )
      ).rows,
    };
  });
}
export async function createType(actor, company, input) {
  const name = text(input?.name, "typeName", 80, true);
  return formsTransaction(
    actor,
    company,
    async (db, tenant) => {
      const row = (
        await db.query(
          `INSERT INTO ${s}.lead_form_types(customer_id,name) VALUES($1,$2) ON CONFLICT(customer_id,lower(name)) DO UPDATE SET deleted_at=NULL,name=EXCLUDED.name WHERE lead_form_types.deleted_at IS NOT NULL RETURNING id,name`,
          [tenant, name],
        )
      ).rows[0];
      if (!row) throw fail("A type with this name already exists.", 409);
      await audit(db, tenant, actor, row.id, "type_created");
      return row;
    },
    true,
  );
}
export async function deleteType(actor, company, id) {
  uuid(id);
  return formsTransaction(
    actor,
    company,
    async (db, tenant) => {
      const row = (
        await db.query(
          `SELECT id FROM ${s}.lead_form_types WHERE customer_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
          [tenant, id],
        )
      ).rows[0];
      if (!row) throw fail("Type not found.", 404);
      if (
        (
          await db.query(
            `SELECT 1 FROM ${s}.lead_forms WHERE customer_id=$1 AND type_id=$2 LIMIT 1`,
            [tenant, id],
          )
        ).rowCount
      )
        throw fail("Move or delete the forms using this type first.", 409);
      await db.query(
        `UPDATE ${s}.lead_form_types SET deleted_at=now() WHERE customer_id=$1 AND id=$2`,
        [tenant, id],
      );
      await audit(db, tenant, actor, id, "type_deleted");
      return { deleted: true };
    },
    true,
  );
}
export async function listForms(actor, company, query) {
  const f = formQuery(query),
    column = {
      name: "lower(f.name)",
      type: "lower(t.name)",
      updated: "f.updated_at",
    }[f.sort];
  return formsTransaction(actor, company, async (db, tenant) => {
    const params = [
      tenant,
      f.q ? `%${f.q.replace(/[\\%_]/g, "\\$&")}%` : "",
      f.typeId,
    ];
    const installed = await publicationsInstalled(db);
    const publicationJoin = installed
      ? `LEFT JOIN ${s}.lead_form_publications p ON p.customer_id=f.customer_id AND p.form_id=f.id AND p.active`
      : "";
    const publicationColumns = installed
      ? `CASE WHEN p.id IS NOT NULL THEN f.customer_id::text || '.' || p.id::text END AS "publicationToken",p.form_version AS "publishedVersion"`
      : `NULL::text AS "publicationToken",NULL::integer AS "publishedVersion"`;
    const where = `FROM ${s}.lead_forms f JOIN ${s}.lead_form_types t ON t.customer_id=f.customer_id AND t.id=f.type_id ${publicationJoin} WHERE f.customer_id=$1 AND ($2='' OR f.name ILIKE $2) AND ($3::uuid IS NULL OR f.type_id=$3)`;
    const result = (
      await db.query(
        `WITH filtered AS (SELECT f.id,f.name,f.type_id AS "typeId",t.name AS "typeName",f.version,f.updated_at AS "updatedAt",${publicationColumns},row_number() OVER(ORDER BY ${column} ${f.direction},f.id) AS ordinal ${where}), paged AS (SELECT * FROM filtered ORDER BY ordinal LIMIT $4 OFFSET $5) SELECT (SELECT count(*)::int FROM filtered) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(paged)-'ordinal' ORDER BY ordinal) FROM paged),'[]'::jsonb) AS items`,
        [...params, f.limit, (f.page - 1) * f.limit],
      )
    ).rows[0];
    return result;
  });
}
export async function getForm(actor, company, id) {
  uuid(id);
  return formsTransaction(actor, company, async (db, tenant) => {
    const row = (
      await db.query(
        `SELECT id,name,type_id AS "typeId",blocks,version,COALESCE(to_jsonb(lead_forms)->>'emails','') AS emails FROM ${s}.lead_forms WHERE customer_id=$1 AND id=$2`,
        [tenant, id],
      )
    ).rows[0];
    if (!row) throw fail("Form not found.", 404);
    return row;
  });
}
export async function saveForm(actor, company, id, input) {
  uuid(id);
  const expected =
      input?.expectedVersion === 0 ? 0 : version(input?.expectedVersion),
    f = formInput(input?.form);
  return formsTransaction(
    actor,
    company,
    async (db, tenant) => {
      if (f.emails) await requireFormEmailSetup(db);
      // Serialize type deletion with form assignment.
      if (
        !(
          await db.query(
            `SELECT id FROM ${s}.lead_form_types WHERE customer_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
            [tenant, f.typeId],
          )
        ).rowCount
      )
        throw fail("Select an available form type.", 400, ["typeId"]);
      const args = [tenant, id, f.name, f.typeId, JSON.stringify(f.blocks)];
      const result =
        expected === 0
          ? await db.query(
              `INSERT INTO ${s}.lead_forms(customer_id,id,name,type_id,blocks,created_by_identity) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING version`,
              [...args, actor],
            )
          : await db.query(
              `UPDATE ${s}.lead_forms SET name=$3,type_id=$4,blocks=$5::jsonb,version=version+1,updated_at=now() WHERE customer_id=$1 AND id=$2 AND version=$6 RETURNING version`,
              [...args, expected],
            );
      if (!result.rowCount)
        throw fail(
          "This form changed or was deleted. Reload before saving.",
          409,
        );
      if (f.emails)
        await db.query(
          `UPDATE ${s}.lead_forms SET emails=$3 WHERE customer_id=$1 AND id=$2`,
          [tenant, id, f.emails],
        );
      await audit(db, tenant, actor, id, "form_saved");
      return { id, ...f, version: result.rows[0].version };
    },
    true,
  );
}
export async function deleteForm(actor, company, id, input) {
  uuid(id);
  const expected = version(input?.expectedVersion);
  return formsTransaction(
    actor,
    company,
    async (db, tenant) => {
      const result = await db.query(
        `DELETE FROM ${s}.lead_forms WHERE customer_id=$1 AND id=$2 AND version=$3`,
        [tenant, id, expected],
      );
      if (!result.rowCount)
        throw fail("This form changed or was deleted. Refresh the list.", 409);
      await audit(db, tenant, actor, id, "form_deleted");
      return { deleted: true };
    },
    true,
  );
}
