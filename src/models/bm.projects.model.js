import pool from "../config/db.js";

const PROJECT_SELECT = `
  p.project_id AS "projectId",
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
  userId,
  { q, status, clientId, limit, offset }
) {
  const params = [userId];
  let i = 2;
  const where = [`p.user_id = $1`];

  if (status) {
    where.push(`p.status = $${i++}`);
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
    JOIN bm_clients c ON c.client_id = p.client_id
    WHERE ${where.join(" AND ")}
    ORDER BY p.createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countProjects(userId, { q, status, clientId }) {
  const params = [userId];
  let i = 2;
  const where = [`p.user_id = $1`];

  if (status) {
    where.push(`p.status = $${i++}`);
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
    JOIN bm_clients c ON c.client_id = p.client_id
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  return rows[0]?.total ?? 0;
}

export async function getProject(userId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_SELECT}
    FROM bm_projects p
    JOIN bm_clients c ON c.client_id = p.client_id
    WHERE p.user_id = $1 AND p.project_id = $2
    LIMIT 1
    `,
    [userId, projectId]
  );
  return rows[0];
}

export async function projectExists(userId, projectId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_projects WHERE user_id = $1 AND project_id = $2 LIMIT 1`,
    [userId, projectId]
  );
  return rows.length > 0;
}

export async function createProject(userId, payload) {
  // Ensure client belongs to user
  const { rows } = await pool.query(
    `
    INSERT INTO bm_projects (
      project_id, user_id, client_id, project_name, description, status, default_pricing, pricing_profile_id
    )
    SELECT gen_random_uuid(), $1, $2, $3, $4, COALESCE($5, 'to_do'), COALESCE($6, true), $7
    WHERE EXISTS (
      SELECT 1 FROM bm_clients WHERE user_id = $1 AND client_id = $2
    )
    RETURNING project_id
    `,
    [
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
  return getProject(userId, rows[0].project_id);
}

export async function updateProject(userId, projectId, payload) {
  const sets = [];
  const params = [userId, projectId];
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
        // Validate new client belongs to user by setting via subquery
        sets.push(
          `${col} = (SELECT client_id FROM bm_clients WHERE user_id = $1 AND client_id = $${i})`
        );
        params.push(payload[k]);
        i++;
        continue;
      }
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getProject(userId, projectId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_projects
    SET ${sets.join(", ")}
    WHERE user_id = $1 AND project_id = $2
    RETURNING project_id
    `,
    params
  );

  return rows[0] ? getProject(userId, projectId) : null;
}

export async function archiveProject(userId, projectId) {
  const res = await pool.query(
    `
    UPDATE bm_projects
    SET status = 'cancelled', updatedat = NOW()
    WHERE user_id = $1 AND project_id = $2
    `,
    [userId, projectId]
  );
  return res.rowCount > 0;
}

/* Project Materials */
const PROJECT_MATERIAL_SELECT = `
  pm.project_id AS "projectId",
  pm.material_id AS "materialId",
  m.material_name AS "materialName",
  pm.quantity,
  pm.unit_cost_override AS "unitCostOverride",
  pm.sell_cost_override AS "sellCostOverride",
  pm.notes
`;

export async function listProjectMaterials(userId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_MATERIAL_SELECT}
    FROM bm_project_materials pm
    JOIN bm_projects p ON p.project_id = pm.project_id
    JOIN bm_materials m ON m.material_id = pm.material_id
    WHERE p.user_id = $1 AND pm.project_id = $2 AND m.user_id = $1
    ORDER BY m.material_name ASC
    `,
    [userId, projectId]
  );
  return rows;
}

export async function upsertProjectMaterial(
  userId,
  projectId,
  materialId,
  payload
) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_project_materials (
      project_id, material_id, quantity, unit_cost_override, sell_cost_override, notes
    )
    SELECT $2, $3, COALESCE($4, 1), $5, $6, $7
    WHERE EXISTS (SELECT 1 FROM bm_projects WHERE user_id = $1 AND project_id = $2)
      AND EXISTS (SELECT 1 FROM bm_materials WHERE user_id = $1 AND material_id = $3)
    ON CONFLICT (project_id, material_id) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      unit_cost_override = EXCLUDED.unit_cost_override,
      sell_cost_override = EXCLUDED.sell_cost_override,
      notes = EXCLUDED.notes
    RETURNING project_id, material_id
    `,
    [
      userId,
      projectId,
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
    WHERE p.user_id = $1 AND pm.project_id = $2 AND pm.material_id = $3
    LIMIT 1
    `,
    [userId, projectId, materialId]
  );

  return out[0] || null;
}

export async function removeProjectMaterial(userId, projectId, materialId) {
  const res = await pool.query(
    `
    DELETE FROM bm_project_materials pm
    USING bm_projects p
    WHERE pm.project_id = p.project_id
      AND p.user_id = $1
      AND pm.project_id = $2
      AND pm.material_id = $3
    `,
    [userId, projectId, materialId]
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

export async function listProjectLabor(userId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT ${PROJECT_LABOR_SELECT}
    FROM bm_project_labor pl
    JOIN bm_projects p ON p.project_id = pl.project_id
    JOIN bm_labor l ON l.labor_id = pl.labor_id
    WHERE p.user_id = $1 AND pl.project_id = $2 AND l.user_id = $1
    ORDER BY l.labor_name ASC
    `,
    [userId, projectId]
  );
  return rows;
}

export async function upsertProjectLabor(userId, projectId, laborId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_project_labor (
      project_id, labor_id, quantity, unit_cost_override, sell_cost_override, notes
    )
    SELECT $2, $3, COALESCE($4, 1), $5, $6, $7
    WHERE EXISTS (SELECT 1 FROM bm_projects WHERE user_id = $1 AND project_id = $2)
      AND EXISTS (SELECT 1 FROM bm_labor WHERE user_id = $1 AND labor_id = $3)
    ON CONFLICT (project_id, labor_id) DO UPDATE SET
      quantity = EXCLUDED.quantity,
      unit_cost_override = EXCLUDED.unit_cost_override,
      sell_cost_override = EXCLUDED.sell_cost_override,
      notes = EXCLUDED.notes
    RETURNING project_id, labor_id
    `,
    [
      userId,
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
    WHERE p.user_id = $1 AND pl.project_id = $2 AND pl.labor_id = $3
    LIMIT 1
    `,
    [userId, projectId, laborId]
  );

  return out[0] || null;
}

export async function removeProjectLabor(userId, projectId, laborId) {
  const res = await pool.query(
    `
    DELETE FROM bm_project_labor pl
    USING bm_projects p
    WHERE pl.project_id = p.project_id
      AND p.user_id = $1
      AND pl.project_id = $2
      AND pl.labor_id = $3
    `,
    [userId, projectId, laborId]
  );
  return res.rowCount > 0;
}
