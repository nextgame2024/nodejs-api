import pool from "../config/db.js";

let schemaReady = false;

const SITE_SELECT = `
  site_id AS "siteId",
  company_id AS "companyId",
  user_id AS "userId",
  site_name AS "siteName",
  administrator,
  address,
  email,
  mobile,
  pallets_onsite AS "palletsOnsite",
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function ensureSitesSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bm_sites (
      site_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      user_id uuid NULL,
      site_name text NOT NULL,
      administrator text NULL,
      address text NULL,
      email text NULL,
      mobile text NULL,
      pallets_onsite integer NOT NULL DEFAULT 0 CHECK (pallets_onsite >= 0),
      status text NOT NULL DEFAULT 'active',
      createdat timestamptz NOT NULL DEFAULT now(),
      updatedat timestamptz NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bm_sites_company_status_name
      ON bm_sites (company_id, status, lower(site_name));
    CREATE INDEX IF NOT EXISTS idx_bm_sites_company_user
      ON bm_sites (company_id, user_id);
  `);
  schemaReady = true;
}

export async function listSites(companyId, { q, status, limit, offset }) {
  await ensureSitesSchema();
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(
      `(site_name ILIKE $${i} OR administrator ILIKE $${i} OR address ILIKE $${i} OR email ILIKE $${i} OR mobile ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${SITE_SELECT}
    FROM bm_sites
    WHERE ${where.join(" AND ")}
    ORDER BY (status = 'archived') ASC, LOWER(site_name) ASC NULLS LAST, createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params,
  );
  return rows;
}

export async function countSites(companyId, { q, status }) {
  await ensureSitesSchema();
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(
      `(site_name ILIKE $${i} OR administrator ILIKE $${i} OR address ILIKE $${i} OR email ILIKE $${i} OR mobile ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM bm_sites WHERE ${where.join(" AND ")}`,
    params,
  );
  return rows[0]?.total ?? 0;
}

export async function getSite(companyId, siteId) {
  await ensureSitesSchema();
  const { rows } = await pool.query(
    `SELECT ${SITE_SELECT} FROM bm_sites WHERE company_id = $1 AND site_id = $2 LIMIT 1`,
    [companyId, siteId],
  );
  return rows[0] ?? null;
}

export async function getUserSite(companyId, userId) {
  await ensureSitesSchema();
  const { rows } = await pool.query(
    `
    SELECT
      s.site_id AS "siteId",
      s.company_id AS "companyId",
      s.user_id AS "userId",
      s.site_name AS "siteName",
      s.administrator,
      s.address,
      s.email,
      s.mobile,
      s.pallets_onsite AS "palletsOnsite",
      s.status,
      s.createdat AS "createdAt",
      s.updatedat AS "updatedAt"
    FROM users u
    JOIN bm_sites s
      ON s.site_id = u.site_id
     AND s.company_id = u.company_id
    WHERE u.company_id = $1
      AND u.id = $2
      AND s.status = 'active'
    LIMIT 1
    `,
    [companyId, userId],
  );
  return rows[0] ?? null;
}

export async function createSite(companyId, userId, payload) {
  await ensureSitesSchema();
  const { rows } = await pool.query(
    `
    INSERT INTO bm_sites (
      site_id, company_id, user_id, site_name, administrator, address, email, mobile, pallets_onsite, status
    ) VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'active')
    )
    RETURNING ${SITE_SELECT}
    `,
    [
      companyId,
      payload.user_id ?? payload.userId ?? null,
      payload.site_name,
      payload.administrator ?? null,
      payload.address ?? null,
      payload.email ?? null,
      payload.mobile ?? null,
      Number(payload.pallets_onsite ?? payload.palletsOnsite ?? 0) || 0,
      payload.status ?? "active",
    ],
  );
  return rows[0];
}

export async function updateSite(companyId, siteId, payload) {
  await ensureSitesSchema();
  const sets = [];
  const params = [companyId, siteId];
  let i = 3;
  const map = {
    site_name: "site_name",
    administrator: "administrator",
    address: "address",
    email: "email",
    mobile: "mobile",
    pallets_onsite: "pallets_onsite",
    status: "status",
  };

  for (const [key, col] of Object.entries(map)) {
    if (payload[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(key === "pallets_onsite" ? Number(payload[key]) || 0 : payload[key]);
    }
  }

  if (payload.palletsOnsite !== undefined && payload.pallets_onsite === undefined) {
    sets.push(`pallets_onsite = $${i++}`);
    params.push(Number(payload.palletsOnsite) || 0);
  }

  if (!sets.length) return getSite(companyId, siteId);
  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_sites
    SET ${sets.join(", ")}
    WHERE company_id = $1 AND site_id = $2
    RETURNING ${SITE_SELECT}
    `,
    params,
  );
  return rows[0] ?? null;
}

export async function archiveSite(companyId, siteId) {
  await ensureSitesSchema();
  const res = await pool.query(
    `
    UPDATE bm_sites
    SET status = 'archived', updatedat = NOW()
    WHERE company_id = $1 AND site_id = $2
    `,
    [companyId, siteId],
  );
  return res.rowCount > 0;
}

export { SITE_SELECT };
