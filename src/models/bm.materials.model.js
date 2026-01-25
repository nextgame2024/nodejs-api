import pool from "../config/db.js";

const MATERIAL_SELECT = `
  material_id AS "materialId",
  user_id AS "userId",
  type,
  material_name AS "materialName",
  unit_cost AS "unitCost",
  sell_cost AS "sellCost",
  code,
  category,
  notes,
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function listMaterials(userId, { q, status, limit, offset }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(
      `(material_name ILIKE $${i} OR code ILIKE $${i} OR category ILIKE $${i})`
    );
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${MATERIAL_SELECT}
    FROM bm_materials
    WHERE ${where.join(" AND ")}
    ORDER BY createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countMaterials(userId, { q, status }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(
      `(material_name ILIKE $${i} OR code ILIKE $${i} OR category ILIKE $${i})`
    );
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM bm_materials WHERE ${where.join(" AND ")}`,
    params
  );
  return rows[0]?.total ?? 0;
}

export async function getMaterial(userId, materialId) {
  const { rows } = await pool.query(
    `SELECT ${MATERIAL_SELECT}
     FROM bm_materials
     WHERE user_id = $1 AND material_id = $2
     LIMIT 1`,
    [userId, materialId]
  );
  return rows[0];
}

export async function createMaterial(userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_materials (
        material_id, user_id, type, material_name, unit_cost, sell_cost, code, category, notes
     ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8
     )
     RETURNING ${MATERIAL_SELECT}`,
    [
      userId,
      payload.type ?? null,
      payload.material_name,
      payload.unit_cost,
      payload.sell_cost ?? null,
      payload.code ?? null,
      payload.category ?? null,
      payload.notes ?? null,
    ]
  );
  return rows[0];
}

export async function updateMaterial(userId, materialId, payload) {
  const sets = [];
  const params = [userId, materialId];
  let i = 3;

  const map = {
    type: "type",
    material_name: "material_name",
    unit_cost: "unit_cost",
    sell_cost: "sell_cost",
    code: "code",
    category: "category",
    notes: "notes",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getMaterial(userId, materialId);
  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_materials
     SET ${sets.join(", ")}
     WHERE user_id = $1 AND material_id = $2
     RETURNING ${MATERIAL_SELECT}`,
    params
  );
  return rows[0];
}

export async function archiveMaterial(userId, materialId) {
  const res = await pool.query(
    `UPDATE bm_materials
     SET status = 'archived', updatedat = NOW()
     WHERE user_id = $1 AND material_id = $2`,
    [userId, materialId]
  );
  return res.rowCount > 0;
}
