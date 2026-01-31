import pool from "../config/db.js";

const PRICING_SELECT = `
  pricing_profile_id AS "pricingProfileId",
  company_id AS "companyId",
  user_id AS "userId",
  profile_name AS "profileName",
  material_markup AS "materialMarkup",
  labor_markup AS "laborMarkup",
  gst_rate AS "gstRate",
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function listPricingProfiles(
  companyId,
  { q, status, limit, offset }
) {
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(profile_name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${PRICING_SELECT}
    FROM bm_pricing_profiles
    WHERE ${where.join(" AND ")}
    ORDER BY profile_name ASC NULLS LAST, createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countPricingProfiles(companyId, { q, status }) {
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(profile_name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM bm_pricing_profiles
     WHERE ${where.join(" AND ")}`,
    params
  );
  return rows[0]?.total ?? 0;
}

export async function getPricingProfile(companyId, pricingProfileId) {
  const { rows } = await pool.query(
    `SELECT ${PRICING_SELECT}
     FROM bm_pricing_profiles
     WHERE company_id = $1 AND pricing_profile_id = $2
     LIMIT 1`,
    [companyId, pricingProfileId]
  );
  return rows[0];
}

export async function createPricingProfile(companyId, userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_pricing_profiles (
        pricing_profile_id, company_id, user_id, profile_name,
        material_markup, labor_markup, gst_rate
     ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6
     )
     RETURNING ${PRICING_SELECT}`,
    [
      companyId,
      userId,
      payload.profile_name,
      payload.material_markup ?? 0,
      payload.labor_markup ?? 0,
      payload.gst_rate ?? 0.1,
    ]
  );
  return rows[0];
}

export async function updatePricingProfile(
  companyId,
  pricingProfileId,
  payload
) {
  const sets = [];
  const params = [companyId, pricingProfileId];
  let i = 3;

  const map = {
    profile_name: "profile_name",
    material_markup: "material_markup",
    labor_markup: "labor_markup",
    gst_rate: "gst_rate",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getPricingProfile(companyId, pricingProfileId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_pricing_profiles
     SET ${sets.join(", ")}
     WHERE company_id = $1 AND pricing_profile_id = $2
     RETURNING ${PRICING_SELECT}`,
    params
  );
  return rows[0];
}

export async function archivePricingProfile(companyId, pricingProfileId) {
  const res = await pool.query(
    `UPDATE bm_pricing_profiles
     SET status = 'archived', updatedat = NOW()
     WHERE company_id = $1 AND pricing_profile_id = $2`,
    [companyId, pricingProfileId]
  );
  return res.rowCount > 0;
}
