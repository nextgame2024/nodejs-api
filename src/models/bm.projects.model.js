import pool from "../config/db.js";

const PROJECT_SELECT = `
  p.project_id AS "projectId",
  p.company_id AS "companyId",
  p.user_id AS "userId",
  p.client_id AS "clientId",
  c.client_name AS "clientName",
  p.project_name AS "projectName",
  p.description,
  p.status,
  p.default_pricing AS "defaultPricing",
  p.pricing_profile_id AS "pricingProfileId",
  p.createdat AS "createdAt",
  p.updatedat AS "updatedAt"
`;

export async function listProjects(
  companyId,
  { q, status, clientId, limit, offset }
) {
  const params = [companyId];
  let i = 2;
  const where = [`p.company_id = $1`];

  if (status) {
    where.push(`p.status = $${i++}::bm_project_status`);
    params.push(status);
  }
  if (clientId) {
    where.push(`p.client_id = $${i++}`);
    params.push(clientId);
  }
  if (q) {
    where.push(`(p.project_name ILIKE $${i} OR c.client_name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_SELECT}
    FROM bm_projects p
    JOIN bm_clients c
      ON c.client_id = p.client_id
     AND c.company_id = p.company_id
    WHERE ${where.join(" AND ")}
    ORDER BY p.createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countProjects(companyId, { q, status, clientId }) {
  const params = [companyId];
  let i = 2;
  const where = [`p.company_id = $1`];

  if (status) {
    where.push(`p.status = $${i++}::bm_project_status`);
    params.push(status);
  }
  if (clientId) {
    where.push(`p.client_id = $${i++}`);
    params.push(clientId);
  }
  if (q) {
    where.push(`(p.project_name ILIKE $${i} OR c.client_name ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_projects p
    JOIN bm_clients c
      ON c.client_id = p.client_id
     AND c.company_id = p.company_id
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  return rows[0]?.total ?? 0;
}

export async function getProject(companyId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_SELECT}
    FROM bm_projects p
    JOIN bm_clients c
      ON c.client_id = p.client_id
     AND c.company_id = p.company_id
    WHERE p.company_id = $1 AND p.project_id = $2
    LIMIT 1
    `,
    [companyId, projectId]
  );
  return rows[0];
}

export async function projectExists(companyId, projectId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_projects WHERE company_id = $1 AND project_id = $2 LIMIT 1`,
    [companyId, projectId]
  );
  return rows.length > 0;
}

export async function createProject(companyId, userId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_projects (
      project_id, company_id, user_id, client_id, project_name, description, status, default_pricing, pricing_profile_id
    )
    SELECT gen_random_uuid(), $1, $2, $3, $4, $5, COALESCE($6::bm_project_status, 'to_do'::bm_project_status), COALESCE($7, true), $8
    WHERE EXISTS (
      SELECT 1 FROM bm_clients WHERE company_id = $1 AND client_id = $3
    )
    RETURNING project_id
    `,
    [
      companyId,
      userId,
      payload.client_id,
      payload.project_name,
      payload.description ?? null,
      payload.status ?? null,
      payload.default_pricing ?? true,
      payload.pricing_profile_id ?? null,
    ]
  );

  if (!rows[0]) return null;
  return getProject(companyId, rows[0].project_id);
}

export async function updateProject(companyId, projectId, payload) {
  const sets = [];
  const params = [companyId, projectId];
  let i = 3;

  const map = {
    project_name: "project_name",
    description: "description",
    status: "status",
    default_pricing: "default_pricing",
    pricing_profile_id: "pricing_profile_id",
    client_id: "client_id",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      if (k === "client_id") {
        sets.push(
          `${col} = (SELECT client_id FROM bm_clients WHERE company_id = $1 AND client_id = $${i})`
        );
        params.push(payload[k]);
        i++;
        continue;
      }
      if (k === "status") {
        sets.push(`${col} = $${i++}::bm_project_status`);
        params.push(payload[k]);
        continue;
      }
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getProject(companyId, projectId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_projects
    SET ${sets.join(", ")}
    WHERE company_id = $1 AND project_id = $2
    RETURNING project_id
    `,
    params
  );

  return rows[0] ? getProject(companyId, projectId) : null;
}

export async function archiveProject(companyId, projectId) {
  const res = await pool.query(
    `
    UPDATE bm_projects
    SET status = 'cancelled', updatedat = NOW()
    WHERE company_id = $1 AND project_id = $2
    `,
    [companyId, projectId]
  );
  return res.rowCount > 0;
}

/* Project Materials */
const PROJECT_MATERIAL_SELECT = `
  pm.project_id AS "projectId",
  pm.material_id AS "materialId",
  pm.supplier_id AS "supplierId",
  s.supplier_name AS "supplierName",
  m.material_name AS "materialName",
  pm.quantity,
  pm.unit_cost_override AS "unitCostOverride",
  pm.sell_cost_override AS "sellCostOverride",
  pm.notes
`;

export async function listProjectMaterials(companyId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_MATERIAL_SELECT}
    FROM bm_project_materials pm
    JOIN bm_projects p ON p.project_id = pm.project_id
    JOIN bm_materials m ON m.material_id = pm.material_id
    LEFT JOIN bm_suppliers s
      ON s.supplier_id = pm.supplier_id
      AND s.company_id = $1
    WHERE p.company_id = $1 AND pm.project_id = $2 AND m.company_id = $1
    ORDER BY m.material_name ASC
    `,
    [companyId, projectId]
  );
  return rows;
}

export async function upsertProjectMaterial(
  companyId,
  projectId,
  materialId,
  payload
) {
  const supplierId = payload?.supplier_id ?? null;
  const { rows } = await pool.query(
    `
    INSERT INTO bm_project_materials (
      company_id, project_id, supplier_id, material_id, quantity, unit_cost_override, sell_cost_override, notes
    )
    SELECT $1, $2, $3, $4, COALESCE($5, 1), $6, $7, $8
    WHERE EXISTS (SELECT 1 FROM bm_projects WHERE company_id = $1 AND project_id = $2)
      AND EXISTS (SELECT 1 FROM bm_materials WHERE company_id = $1 AND material_id = $4)
      AND (
        $3 IS NULL OR EXISTS (
          SELECT 1 FROM bm_suppliers WHERE company_id = $1 AND supplier_id = $3
        )
      )
      AND (
        $3 IS NULL OR EXISTS (
          SELECT 1 FROM bm_supplier_materials sm
          WHERE sm.company_id = $1 AND sm.supplier_id = $3 AND sm.material_id = $4
        )
      )
    ON CONFLICT (project_id, material_id) DO UPDATE SET
      supplier_id = EXCLUDED.supplier_id,
      quantity = EXCLUDED.quantity,
      unit_cost_override = EXCLUDED.unit_cost_override,
      sell_cost_override = EXCLUDED.sell_cost_override,
      notes = EXCLUDED.notes
    RETURNING project_id, material_id
    `,
    [
      companyId,
      projectId,
      supplierId,
      materialId,
      payload.quantity ?? 1,
      payload.unit_cost_override ?? null,
      payload.sell_cost_override ?? null,
      payload.notes ?? null,
    ]
  );

  if (!rows[0]) return null;

  const { rows: out } = await pool.query(
    `
    SELECT ${PROJECT_MATERIAL_SELECT}
    FROM bm_project_materials pm
    JOIN bm_projects p ON p.project_id = pm.project_id
    JOIN bm_materials m ON m.material_id = pm.material_id
    LEFT JOIN bm_suppliers s
      ON s.supplier_id = pm.supplier_id
      AND s.company_id = $1
    WHERE p.company_id = $1 AND pm.project_id = $2 AND pm.material_id = $3
    LIMIT 1
    `,
    [companyId, projectId, materialId]
  );

  return out[0] || null;
}

export async function removeProjectMaterial(companyId, projectId, materialId) {
  const res = await pool.query(
    `
    DELETE FROM bm_project_materials pm
    USING bm_projects p
    WHERE pm.project_id = p.project_id
      AND p.company_id = $1
      AND pm.project_id = $2
      AND pm.material_id = $3
    `,
    [companyId, projectId, materialId]
  );
  return res.rowCount > 0;
}

/* Project Labor */
const PROJECT_LABOR_SELECT = `
  pl.project_id AS "projectId",
  pl.labor_id AS "laborId",
  l.labor_name AS "laborName",
  l.unit_type AS "unitType",
  pl.quantity,
  pl.unit_cost_override AS "unitCostOverride",
  pl.sell_cost_override AS "sellCostOverride",
  pl.notes
`;

export async function listProjectLabor(companyId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_LABOR_SELECT}
    FROM bm_project_labor pl
    JOIN bm_projects p ON p.project_id = pl.project_id
    JOIN bm_labor l ON l.labor_id = pl.labor_id
    WHERE p.company_id = $1 AND pl.project_id = $2 AND l.company_id = $1
    ORDER BY l.labor_name ASC
    `,
    [companyId, projectId]
  );
  return rows;
}

export async function upsertProjectLabor(
  companyId,
  projectId,
  laborId,
  payload
) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_project_labor (
      company_id, project_id, labor_id, quantity, unit_cost_override, sell_cost_override, notes
    )
    SELECT $1, $2, $3, COALESCE($4, 1), $5, $6, $7
    WHERE EXISTS (SELECT 1 FROM bm_projects WHERE company_id = $1 AND project_id = $2)
      AND EXISTS (SELECT 1 FROM bm_labor WHERE company_id = $1 AND labor_id = $3)
    ON CONFLICT (project_id, labor_id) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      unit_cost_override = EXCLUDED.unit_cost_override,
      sell_cost_override = EXCLUDED.sell_cost_override,
      notes = EXCLUDED.notes
    RETURNING project_id, labor_id
    `,
    [
      companyId,
      projectId,
      laborId,
      payload.quantity ?? 1,
      payload.unit_cost_override ?? null,
      payload.sell_cost_override ?? null,
      payload.notes ?? null,
    ]
  );

  if (!rows[0]) return null;

  const { rows: out } = await pool.query(
    `
    SELECT ${PROJECT_LABOR_SELECT}
    FROM bm_project_labor pl
    JOIN bm_projects p ON p.project_id = pl.project_id
    JOIN bm_labor l ON l.labor_id = pl.labor_id
    WHERE p.company_id = $1 AND pl.project_id = $2 AND pl.labor_id = $3
    LIMIT 1
    `,
    [companyId, projectId, laborId]
  );

  return out[0] || null;
}

export async function removeProjectLabor(companyId, projectId, laborId) {
  const res = await pool.query(
    `
    DELETE FROM bm_project_labor pl
    USING bm_projects p
    WHERE pl.project_id = p.project_id
      AND p.company_id = $1
      AND pl.project_id = $2
      AND pl.labor_id = $3
    `,
    [companyId, projectId, laborId]
  );
  return res.rowCount > 0;
}
