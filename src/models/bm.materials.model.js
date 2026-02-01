import pool from "../config/db.js";

const MATERIAL_SELECT = `
  material_id AS "materialId",
  company_id AS "companyId",
  user_id AS "userId",
  type,
  material_name AS "materialName",
  code,
  category,
  notes,
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function listMaterials(companyId, { q, status, limit, offset }) {
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

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
    ORDER BY material_name ASC NULLS LAST, createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countMaterials(companyId, { q, status }) {
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

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

export async function getMaterial(companyId, materialId) {
  const { rows } = await pool.query(
    `SELECT ${MATERIAL_SELECT}
     FROM bm_materials
     WHERE company_id = $1 AND material_id = $2
     LIMIT 1`,
    [companyId, materialId]
  );
  return rows[0];
}

export async function createMaterial(companyId, userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_materials (
        material_id, company_id, user_id, type, material_name, code, category, notes
     ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7
     )
     RETURNING ${MATERIAL_SELECT}`,
    [
      companyId,
      userId,
      payload.type ?? null,
      payload.material_name,
      payload.code ?? null,
      payload.category ?? null,
      payload.notes ?? null,
    ]
  );
  return rows[0];
}

export async function updateMaterial(companyId, materialId, payload) {
  const sets = [];
  const params = [companyId, materialId];
  let i = 3;

  const map = {
    type: "type",
    material_name: "material_name",
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

  if (!sets.length) return getMaterial(companyId, materialId);
  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_materials
     SET ${sets.join(", ")}
     WHERE company_id = $1 AND material_id = $2
     RETURNING ${MATERIAL_SELECT}`,
    params
  );
  return rows[0];
}

export async function archiveMaterial(companyId, materialId) {
  const res = await pool.query(
    `UPDATE bm_materials
     SET status = 'archived', updatedat = NOW()
     WHERE company_id = $1 AND material_id = $2`,
    [companyId, materialId]
  );
  return res.rowCount > 0;
}
