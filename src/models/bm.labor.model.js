import pool from "../config/db.js";

const LABOR_SELECT = `
  labor_id AS "laborId",
  user_id AS "userId",
  labor_name AS "laborName",
  unit_type AS "unitType",
  unit_cost AS "unitCost",
  sell_cost AS "sellCost",
  unit_productivity AS "unitProductivity",
  productivity_unit AS "productivityUnit",
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function listLabor(userId, { q, status, limit, offset }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(labor_name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${LABOR_SELECT}
    FROM bm_labor
    WHERE ${where.join(" AND ")}
    ORDER BY createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countLabor(userId, { q, status }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(labor_name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM bm_labor
     WHERE ${where.join(" AND ")}`,
    params
  );
  return rows[0]?.total ?? 0;
}

export async function getLabor(userId, laborId) {
  const { rows } = await pool.query(
    `SELECT ${LABOR_SELECT}
     FROM bm_labor
     WHERE user_id = $1 AND labor_id = $2
     LIMIT 1`,
    [userId, laborId]
  );
  return rows[0];
}

export async function createLabor(userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_labor (
        labor_id, user_id, labor_name, unit_type, unit_cost, sell_cost,
        unit_productivity, productivity_unit
     ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7
     )
     RETURNING ${LABOR_SELECT}`,
    [
      userId,
      payload.labor_name,
      payload.unit_type ?? "hour",
      payload.unit_cost,
      payload.sell_cost ?? null,
      payload.unit_productivity ?? null,
      payload.productivity_unit ?? null,
    ]
  );
  return rows[0];
}

export async function updateLabor(userId, laborId, payload) {
  const sets = [];
  const params = [userId, laborId];
  let i = 3;

  const map = {
    labor_name: "labor_name",
    unit_type: "unit_type",
    unit_cost: "unit_cost",
    sell_cost: "sell_cost",
    unit_productivity: "unit_productivity",
    productivity_unit: "productivity_unit",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getLabor(userId, laborId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_labor
     SET ${sets.join(", ")}
     WHERE user_id = $1 AND labor_id = $2
     RETURNING ${LABOR_SELECT}`,
    params
  );

  return rows[0];
}

export async function archiveLabor(userId, laborId) {
  const res = await pool.query(
    `UPDATE bm_labor
     SET status = 'archived', updatedat = NOW()
     WHERE user_id = $1 AND labor_id = $2`,
    [userId, laborId]
  );
  return res.rowCount > 0;
}
