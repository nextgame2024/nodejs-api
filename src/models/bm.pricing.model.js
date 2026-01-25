import pool from "../config/db.js";

const PRICING_SELECT = `
  pricing_profile_id AS "pricingProfileId",
  user_id AS "userId",
  profile_name AS "profileName",
  material_markup AS "materialMarkup",
  labor_markup AS "laborMarkup",
  gst_rate AS "gstRate",
  is_default AS "isDefault",
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function listPricingProfiles(
  userId,
  { q, status, limit, offset }
) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

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
    ORDER BY is_default DESC, createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countPricingProfiles(userId, { q, status }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

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

export async function getPricingProfile(userId, pricingProfileId) {
  const { rows } = await pool.query(
    `SELECT ${PRICING_SELECT}
     FROM bm_pricing_profiles
     WHERE user_id = $1 AND pricing_profile_id = $2
     LIMIT 1`,
    [userId, pricingProfileId]
  );
  return rows[0];
}

export async function createPricingProfile(userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_pricing_profiles (
        pricing_profile_id, user_id, profile_name,
        material_markup, labor_markup, gst_rate, is_default
     ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6
     )
     RETURNING ${PRICING_SELECT}`,
    [
      userId,
      payload.profile_name,
      payload.material_markup ?? 0,
      payload.labor_markup ?? 0,
      payload.gst_rate ?? 0.1,
      payload.is_default ?? false,
    ]
  );
  return rows[0];
}

export async function updatePricingProfile(userId, pricingProfileId, payload) {
  const sets = [];
  const params = [userId, pricingProfileId];
  let i = 3;

  const map = {
    profile_name: "profile_name",
    material_markup: "material_markup",
    labor_markup: "labor_markup",
    gst_rate: "gst_rate",
    is_default: "is_default",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getPricingProfile(userId, pricingProfileId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_pricing_profiles
     SET ${sets.join(", ")}
     WHERE user_id = $1 AND pricing_profile_id = $2
     RETURNING ${PRICING_SELECT}`,
    params
  );
  return rows[0];
}

export async function archivePricingProfile(userId, pricingProfileId) {
  const res = await pool.query(
    `UPDATE bm_pricing_profiles
     SET status = 'archived', updatedat = NOW()
     WHERE user_id = $1 AND pricing_profile_id = $2`,
    [userId, pricingProfileId]
  );
  return res.rowCount > 0;
}

export async function clearDefaultPricingProfiles(userId) {
  await pool.query(
    `UPDATE bm_pricing_profiles
     SET is_default = false, updatedat = NOW()
     WHERE user_id = $1`,
    [userId]
  );
}

export async function setDefaultPricingProfile(userId, pricingProfileId) {
  const { rows } = await pool.query(
    `UPDATE bm_pricing_profiles
     SET is_default = true, updatedat = NOW()
     WHERE user_id = $1 AND pricing_profile_id = $2
     RETURNING ${PRICING_SELECT}`,
    [userId, pricingProfileId]
  );
  return rows[0];
}
