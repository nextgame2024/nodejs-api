import pool from "../config/db.js";

const PROJECT_TYPE_SELECT = `
  pt.project_type_id AS "projectTypeId",
  pt.company_id AS "companyId",
  pt.user_id AS "userId",
  pt.name,
  pt.notes,
  pt.status,
  pt.createdat AS "createdAt",
  pt.updatedat AS "updatedAt"
`;

export async function listProjectTypes(companyId, { q, status, limit, offset }) {
  const params = [companyId];
  let i = 2;
  const where = [`pt.company_id = $1`];

  if (status) {
    where.push(`pt.status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`pt.name ILIKE $${i}`);
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_TYPE_SELECT}
    FROM bm_project_types pt
    WHERE ${where.join(" AND ")}
    ORDER BY pt.createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params,
  );

  return rows;
}

export async function countProjectTypes(companyId, { q, status }) {
  const params = [companyId];
  let i = 2;
  const where = [`pt.company_id = $1`];

  if (status) {
    where.push(`pt.status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`pt.name ILIKE $${i}`);
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_project_types pt
    WHERE ${where.join(" AND ")}
    `,
    params,
  );
  return rows[0]?.total ?? 0;
}

export async function getProjectType(companyId, projectTypeId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_TYPE_SELECT}
    FROM bm_project_types pt
    WHERE pt.company_id = $1 AND pt.project_type_id = $2
    LIMIT 1
    `,
    [companyId, projectTypeId],
  );
  return rows[0];
}

export async function projectTypeExists(companyId, projectTypeId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_project_types WHERE company_id = $1 AND project_type_id = $2 LIMIT 1`,
    [companyId, projectTypeId],
  );
  return rows.length > 0;
}

export async function createProjectType(companyId, userId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_project_types (
      project_type_id, company_id, user_id, name, notes, status
    )
    VALUES (
      gen_random_uuid(), $1, $2, $3, $4, COALESCE($5, 'active')
    )
    RETURNING project_type_id
    `,
    [
      companyId,
      userId,
      payload.name,
      payload.notes ?? null,
      payload.status ?? null,
    ],
  );

  if (!rows[0]) return null;
  return getProjectType(companyId, rows[0].project_type_id);
}

export async function updateProjectType(companyId, projectTypeId, payload) {
  const sets = [];
  const params = [companyId, projectTypeId];
  let i = 3;

  const map = {
    name: "name",
    notes: "notes",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getProjectType(companyId, projectTypeId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_project_types
    SET ${sets.join(", ")}
    WHERE company_id = $1 AND project_type_id = $2
    RETURNING project_type_id
    `,
    params,
  );
  return rows[0] ? getProjectType(companyId, projectTypeId) : null;
}

export async function archiveProjectType(companyId, projectTypeId) {
  const res = await pool.query(
    `
    UPDATE bm_project_types
    SET status = 'archived', updatedat = NOW()
    WHERE company_id = $1 AND project_type_id = $2
    `,
    [companyId, projectTypeId],
  );
  return res.rowCount > 0;
}

/* Project Type Materials */
const PROJECT_TYPE_MATERIAL_SELECT = `
  ptm.project_type_id AS "projectTypeId",
  ptm.material_id AS "materialId",
  ptm.supplier_id AS "supplierId",
  s.supplier_name AS "supplierName",
  m.material_name AS "materialName",
  COALESCE(ptm.unit, m.unit) AS "unit",
  ptm.coverage_ratio AS "coverageRatio",
  ptm.coverage_unit AS "coverageUnit",
  ptm.quantity,
  ptm.unit_cost_override AS "unitCostOverride",
  ptm.sell_cost_override AS "sellCostOverride",
  ptm.notes
`;

export async function listProjectTypeMaterials(companyId, projectTypeId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_TYPE_MATERIAL_SELECT}
    FROM bm_project_types_materials ptm
    JOIN bm_project_types pt ON pt.project_type_id = ptm.project_type_id
    JOIN bm_materials m ON m.material_id = ptm.material_id
    LEFT JOIN bm_suppliers s
      ON s.supplier_id = ptm.supplier_id
      AND s.company_id = $1
    WHERE pt.company_id = $1
      AND ptm.project_type_id = $2
      AND m.company_id = $1
    ORDER BY m.material_name ASC
    `,
    [companyId, projectTypeId],
  );
  return rows;
}

export async function upsertProjectTypeMaterial(
  companyId,
  projectTypeId,
  materialId,
  payload,
) {
  const supplierId = payload?.supplier_id ?? null;
  const { rows } = await pool.query(
    `
    INSERT INTO bm_project_types_materials (
      company_id, project_type_id, supplier_id, material_id, unit,
      coverage_ratio, coverage_unit, quantity,
      unit_cost_override, sell_cost_override, notes
    )
    SELECT $1, $2, $3::uuid, $4::uuid, $5, $6, $7, COALESCE($8, 1), $9, $10, $11
    WHERE EXISTS (
      SELECT 1 FROM bm_project_types WHERE company_id = $1 AND project_type_id = $2
    )
      AND EXISTS (
        SELECT 1 FROM bm_materials WHERE company_id = $1 AND material_id = $4::uuid
      )
      AND (
        $3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM bm_suppliers WHERE company_id = $1 AND supplier_id = $3::uuid
        )
      )
    ON CONFLICT (project_type_id, material_id) DO UPDATE SET
      supplier_id = EXCLUDED.supplier_id,
      unit = EXCLUDED.unit,
      coverage_ratio = EXCLUDED.coverage_ratio,
      coverage_unit = EXCLUDED.coverage_unit,
      quantity = EXCLUDED.quantity,
      unit_cost_override = EXCLUDED.unit_cost_override,
      sell_cost_override = EXCLUDED.sell_cost_override,
      notes = EXCLUDED.notes,
      updatedat = NOW()
    RETURNING project_type_id, material_id
    `,
    [
      companyId,
      projectTypeId,
      supplierId,
      materialId,
      payload.unit ?? null,
      payload.coverage_ratio ?? null,
      payload.coverage_unit ?? null,
      payload.quantity ?? 1,
      payload.unit_cost_override ?? null,
      payload.sell_cost_override ?? null,
      payload.notes ?? null,
    ],
  );

  if (!rows[0]) return null;
  const items = await listProjectTypeMaterials(companyId, projectTypeId);
  return items.find((m) => m.materialId === materialId) ?? null;
}

export async function removeProjectTypeMaterial(
  companyId,
  projectTypeId,
  materialId,
) {
  const res = await pool.query(
    `
    DELETE FROM bm_project_types_materials
    WHERE company_id = $1 AND project_type_id = $2 AND material_id = $3
    `,
    [companyId, projectTypeId, materialId],
  );
  return res.rowCount > 0;
}

/* Project Type Labor */
const PROJECT_TYPE_LABOR_SELECT = `
  ptl.project_type_id AS "projectTypeId",
  ptl.labor_id AS "laborId",
  l.labor_name AS "laborName",
  COALESCE(ptl.unit_type, l.unit_type) AS "unitType",
  ptl.unit_cost_override AS "unitCostOverride",
  ptl.sell_cost_override AS "sellCostOverride",
  ptl.unit_productivity AS "unitProductivity",
  ptl.productivity_unit AS "productivityUnit",
  ptl.notes
`;

export async function listProjectTypeLabor(companyId, projectTypeId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_TYPE_LABOR_SELECT}
    FROM bm_project_types_labor ptl
    JOIN bm_project_types pt ON pt.project_type_id = ptl.project_type_id
    JOIN bm_labor l ON l.labor_id = ptl.labor_id
    WHERE pt.company_id = $1
      AND ptl.project_type_id = $2
      AND l.company_id = $1
    ORDER BY l.labor_name ASC
    `,
    [companyId, projectTypeId],
  );
  return rows;
}

export async function upsertProjectTypeLabor(
  companyId,
  projectTypeId,
  laborId,
  payload,
) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_project_types_labor (
      company_id, project_type_id, labor_id, unit_type,
      unit_cost_override, sell_cost_override,
      unit_productivity, productivity_unit, notes
    )
    SELECT $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9
    WHERE EXISTS (
      SELECT 1 FROM bm_project_types WHERE company_id = $1 AND project_type_id = $2
    )
      AND EXISTS (
        SELECT 1 FROM bm_labor WHERE company_id = $1 AND labor_id = $3::uuid
      )
    ON CONFLICT (project_type_id, labor_id) DO UPDATE SET
      unit_type = EXCLUDED.unit_type,
      unit_cost_override = EXCLUDED.unit_cost_override,
      sell_cost_override = EXCLUDED.sell_cost_override,
      unit_productivity = EXCLUDED.unit_productivity,
      productivity_unit = EXCLUDED.productivity_unit,
      notes = EXCLUDED.notes,
      updatedat = NOW()
    RETURNING project_type_id, labor_id
    `,
    [
      companyId,
      projectTypeId,
      laborId,
      payload.unit_type ?? null,
      payload.unit_cost_override ?? null,
      payload.sell_cost_override ?? null,
      payload.unit_productivity ?? null,
      payload.productivity_unit ?? null,
      payload.notes ?? null,
    ],
  );

  if (!rows[0]) return null;
  const items = await listProjectTypeLabor(companyId, projectTypeId);
  return items.find((l) => l.laborId === laborId) ?? null;
}

export async function removeProjectTypeLabor(
  companyId,
  projectTypeId,
  laborId,
) {
  const res = await pool.query(
    `
    DELETE FROM bm_project_types_labor
    WHERE company_id = $1 AND project_type_id = $2 AND labor_id = $3
    `,
    [companyId, projectTypeId, laborId],
  );
  return res.rowCount > 0;
}
