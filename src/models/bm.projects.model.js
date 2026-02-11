import pool from "../config/db.js";

const PROJECT_SELECT = `
  p.project_id AS "projectId",
  p.company_id AS "companyId",
  p.user_id AS "userId",
  p.client_id AS "clientId",
  c.client_name AS "clientName",
  c.address AS "clientAddress",
  p.project_name AS "projectName",
  p.meters_required AS "metersRequired",
  p.description,
  p.status,
  p.status_before_hold AS "statusBeforeHold",
  p.default_pricing AS "defaultPricing",
  p.cost_in_quote AS "costInQuote",
  p.project_type_id AS "projectTypeId",
  pt.name AS "projectTypeName",
  p.pricing_profile_id AS "pricingProfileId",
  pp.profile_name AS "pricingProfileName",
  q.document_id AS "quoteDocumentId",
  q.doc_number AS "quoteDocNumber",
  q.pdf_url AS "quotePdfUrl",
  inv.document_id AS "invoiceDocumentId",
  inv.doc_number AS "invoiceDocNumber",
  inv.pdf_url AS "invoicePdfUrl",
  inv.invoice_status AS "invoiceStatus",
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
    where.push(
      `(p.project_name ILIKE $${i} OR c.client_name ILIKE $${i} OR c.address ILIKE $${i} OR p.description ILIKE $${i})`
    );
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT
      ${PROJECT_SELECT},
      (
        EXISTS (
          SELECT 1
          FROM bm_documents d
          WHERE d.company_id = p.company_id
            AND d.project_id = p.project_id
        )
        OR EXISTS (
          SELECT 1
          FROM bm_project_materials pm
          WHERE pm.company_id = p.company_id
            AND pm.project_id = p.project_id
        )
        OR EXISTS (
          SELECT 1
          FROM bm_project_labor pl
          WHERE pl.company_id = p.company_id
            AND pl.project_id = p.project_id
        )
      ) AS "hasProjects"
    FROM bm_projects p
    JOIN bm_clients c
      ON c.client_id = p.client_id
     AND c.company_id = p.company_id
    LEFT JOIN bm_project_types pt
      ON pt.project_type_id = p.project_type_id
     AND pt.company_id = p.company_id
    LEFT JOIN bm_pricing_profiles pp
      ON pp.pricing_profile_id = p.pricing_profile_id
     AND pp.company_id = p.company_id
    LEFT JOIN LATERAL (
      SELECT document_id, doc_number, pdf_url
      FROM bm_documents
      WHERE company_id = p.company_id
        AND project_id = p.project_id
        AND type = 'quote'
      ORDER BY createdat ASC
      LIMIT 1
    ) q ON true
    LEFT JOIN LATERAL (
      SELECT document_id, doc_number, pdf_url, invoice_status
      FROM bm_documents
      WHERE company_id = p.company_id
        AND project_id = p.project_id
        AND type = 'invoice'
      ORDER BY createdat ASC
      LIMIT 1
    ) inv ON true
    WHERE ${where.join(" AND ")}
    ORDER BY (p.status = 'archived') ASC, p.createdat DESC
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
    where.push(
      `(p.project_name ILIKE $${i} OR c.client_name ILIKE $${i} OR c.address ILIKE $${i} OR p.description ILIKE $${i})`
    );
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
    LEFT JOIN bm_project_types pt
      ON pt.project_type_id = p.project_type_id
     AND pt.company_id = p.company_id
    LEFT JOIN bm_pricing_profiles pp
      ON pp.pricing_profile_id = p.pricing_profile_id
     AND pp.company_id = p.company_id
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
    LEFT JOIN bm_project_types pt
      ON pt.project_type_id = p.project_type_id
     AND pt.company_id = p.company_id
    LEFT JOIN bm_pricing_profiles pp
      ON pp.pricing_profile_id = p.pricing_profile_id
     AND pp.company_id = p.company_id
    LEFT JOIN LATERAL (
      SELECT document_id, doc_number, pdf_url
      FROM bm_documents
      WHERE company_id = p.company_id
        AND project_id = p.project_id
        AND type = 'quote'
      ORDER BY createdat ASC
      LIMIT 1
    ) q ON true
    LEFT JOIN LATERAL (
      SELECT document_id, doc_number, pdf_url, invoice_status
      FROM bm_documents
      WHERE company_id = p.company_id
        AND project_id = p.project_id
        AND type = 'invoice'
      ORDER BY createdat ASC
      LIMIT 1
    ) inv ON true
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `
      INSERT INTO bm_projects (
      project_id,
      company_id,
      user_id,
      client_id,
      project_name,
      meters_required,
      description,
      status,
      default_pricing,
      cost_in_quote,
      project_type_id,
      pricing_profile_id
    )
    SELECT
      gen_random_uuid(),
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      COALESCE($7::bm_project_status, 'to_do'::bm_project_status),
      COALESCE($8, true),
      COALESCE($9, false),
      (SELECT project_type_id FROM bm_project_types WHERE company_id = $1 AND project_type_id = $10),
      $11
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
        payload.meters_required ?? null,
        payload.description ?? null,
        payload.status ?? null,
        payload.default_pricing ?? true,
        payload.cost_in_quote ?? false,
        payload.project_type_id ?? null,
        payload.pricing_profile_id ?? null,
      ]
    );

    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const projectId = rows[0].project_id;
    if (payload.project_type_id) {
      await applyProjectTypeToProjectTx(
        client,
        companyId,
        projectId,
        payload.project_type_id
      );
    }

    await client.query("COMMIT");
    return getProject(companyId, projectId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateProject(companyId, projectId, payload) {
  const sets = [];
  const params = [companyId, projectId];
  let i = 3;
  let statusBeforeHoldUpdate = undefined;

  if (payload.status !== undefined) {
    const { rows: statusRows } = await pool.query(
      `
      SELECT status, status_before_hold
      FROM bm_projects
      WHERE company_id = $1 AND project_id = $2
      LIMIT 1
      `,
      [companyId, projectId]
    );
    if (!statusRows[0]) return null;

    const currentStatus = statusRows[0].status;
    const statusBeforeHold = statusRows[0].status_before_hold;
    const nextStatus = payload.status;

    const lockedStatuses = new Set(["done", "cancelled", "archived"]);
    if (lockedStatuses.has(currentStatus) && nextStatus !== currentStatus) {
      const err = new Error(
        "Status cannot be changed once it is Done or Cancelled."
      );
      err.statusCode = 400;
      throw err;
    }

    if (currentStatus === "on_hold" && nextStatus !== "on_hold") {
      if (nextStatus !== "cancelled" && statusBeforeHold && nextStatus !== statusBeforeHold) {
        const err = new Error(
          `Status can only return to ${statusBeforeHold} after On hold.`
        );
        err.statusCode = 400;
        throw err;
      }
      statusBeforeHoldUpdate = null;
    }

    if (nextStatus === "on_hold" && currentStatus !== "on_hold") {
      statusBeforeHoldUpdate = currentStatus;
    }

    if (currentStatus !== "on_hold") {
      const allowedMap = {
        to_do: new Set([
          "to_do",
          "in_progress",
          "quote_created",
          "quote_approved",
          "on_hold",
          "cancelled",
        ]),
        in_progress: new Set([
          "in_progress",
          "quote_created",
          "quote_approved",
          "on_hold",
          "cancelled",
        ]),
        quote_created: new Set([
          "quote_created",
          "quote_approved",
          "on_hold",
          "cancelled",
        ]),
        quote_approved: new Set([
          "quote_approved",
          "invoice_process",
          "on_hold",
          "cancelled",
        ]),
        invoice_process: new Set([
          "invoice_process",
          "done",
          "on_hold",
          "cancelled",
        ]),
        on_hold: new Set(["on_hold"]),
        done: new Set(["done"]),
        cancelled: new Set(["cancelled"]),
        archived: new Set(["archived"]),
      };

      const allowed = allowedMap[currentStatus] || new Set([currentStatus]);
      if (!allowed.has(nextStatus)) {
        const err = new Error(
          `Invalid status transition: ${currentStatus} -> ${nextStatus}`
        );
        err.statusCode = 400;
        throw err;
      }
    }
  }

  const map = {
    project_name: "project_name",
    meters_required: "meters_required",
    description: "description",
    status: "status",
    default_pricing: "default_pricing",
    cost_in_quote: "cost_in_quote",
    pricing_profile_id: "pricing_profile_id",
    client_id: "client_id",
    project_type_id: "project_type_id",
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
      if (k === "project_type_id") {
        if (payload[k] === null) {
          sets.push(`${col} = NULL`);
          continue;
        }
        sets.push(
          `${col} = (SELECT project_type_id FROM bm_project_types WHERE company_id = $1 AND project_type_id = $${i})`
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
      if (k === "cost_in_quote") {
        sets.push(`${col} = $${i++}`);
        params.push(Boolean(payload[k]));
        continue;
      }
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getProject(companyId, projectId);

  if (statusBeforeHoldUpdate !== undefined) {
    if (statusBeforeHoldUpdate === null) {
      sets.push(`status_before_hold = NULL`);
    } else {
      sets.push(`status_before_hold = $${i++}::bm_project_status`);
      params.push(statusBeforeHoldUpdate);
    }
  }

  sets.push(`updatedat = NOW()`);

  const shouldApplyProjectType =
    payload.project_type_id !== undefined && payload.project_type_id !== null;

  if (!shouldApplyProjectType) {
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `
      UPDATE bm_projects
      SET ${sets.join(", ")}
      WHERE company_id = $1 AND project_id = $2
      RETURNING project_id
      `,
      params
    );

    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    await applyProjectTypeToProjectTx(
      client,
      companyId,
      projectId,
      payload.project_type_id
    );

    await client.query("COMMIT");
    return getProject(companyId, projectId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function applyProjectTypeToProjectTx(
  client,
  companyId,
  projectId,
  projectTypeId
) {
  await client.query(
    `
    DELETE FROM bm_project_materials
    WHERE project_id = $2 AND company_id = $1
    `,
    [companyId, projectId]
  );

  await client.query(
    `
    DELETE FROM bm_project_labor
    WHERE project_id = $2 AND company_id = $1
    `,
    [companyId, projectId]
  );

  await client.query(
    `
    INSERT INTO bm_project_materials (
      company_id,
      project_id,
      supplier_id,
      material_id,
      unit,
      coverage_ratio,
      coverage_unit,
      quantity,
      unit_cost_override,
      sell_cost_override,
      notes
    )
    SELECT
      $1,
      $2,
      supplier_id,
      material_id,
      unit,
      coverage_ratio,
      coverage_unit,
      quantity,
      unit_cost_override,
      sell_cost_override,
      notes
    FROM bm_project_types_materials
    WHERE company_id = $1 AND project_type_id = $3
    `,
    [companyId, projectId, projectTypeId]
  );

  await client.query(
    `
    INSERT INTO bm_project_labor (
      company_id,
      project_id,
      labor_id,
      unit_type,
      unit_productivity,
      productivity_unit,
      quantity,
      unit_cost_override,
      sell_cost_override,
      notes
    )
    SELECT
      $1,
      $2,
      labor_id,
      unit_type,
      unit_productivity,
      productivity_unit,
      1,
      unit_cost_override,
      sell_cost_override,
      notes
    FROM bm_project_types_labor
    WHERE company_id = $1 AND project_type_id = $3
    `,
    [companyId, projectId, projectTypeId]
  );
}

export async function archiveProject(companyId, projectId) {
  const res = await pool.query(
    `
    UPDATE bm_projects
    SET status = 'archived', updatedat = NOW()
    WHERE company_id = $1 AND project_id = $2
    `,
    [companyId, projectId]
  );
  return res.rowCount > 0;
}

export async function projectHasRelations(companyId, projectId) {
  const { rows } = await pool.query(
    `
    SELECT (
      EXISTS (
        SELECT 1
        FROM bm_documents d
        WHERE d.company_id = $1 AND d.project_id = $2
      )
      OR EXISTS (
        SELECT 1
        FROM bm_project_materials pm
        WHERE pm.company_id = $1 AND pm.project_id = $2
      )
      OR EXISTS (
        SELECT 1
        FROM bm_project_labor pl
        WHERE pl.company_id = $1 AND pl.project_id = $2
      )
    ) AS "hasRelations"
    `,
    [companyId, projectId]
  );

  return rows[0]?.hasRelations ?? false;
}

export async function deleteProject(companyId, projectId) {
  const res = await pool.query(
    `DELETE FROM bm_projects WHERE company_id = $1 AND project_id = $2`,
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
  COALESCE(pm.unit, m.unit) AS "unit",
  pm.coverage_ratio AS "coverageRatio",
  pm.coverage_unit AS "coverageUnit",
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
      company_id, project_id, supplier_id, material_id, unit, coverage_ratio, coverage_unit,
      quantity, unit_cost_override, sell_cost_override, notes
    )
    SELECT $1, $2, $3::uuid, $4::uuid, $5, $6, $7, COALESCE($8, 1), $9, $10, $11
    WHERE EXISTS (SELECT 1 FROM bm_projects WHERE company_id = $1 AND project_id = $2)
      AND EXISTS (SELECT 1 FROM bm_materials WHERE company_id = $1 AND material_id = $4::uuid)
      AND (
        $3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM bm_suppliers WHERE company_id = $1 AND supplier_id = $3::uuid
        )
      )
      AND (
        $3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM bm_supplier_materials sm
          WHERE sm.company_id = $1 AND sm.supplier_id = $3::uuid AND sm.material_id = $4::uuid
        )
      )
    ON CONFLICT (project_id, material_id) DO UPDATE SET
      supplier_id = EXCLUDED.supplier_id,
      unit = EXCLUDED.unit,
      coverage_ratio = EXCLUDED.coverage_ratio,
      coverage_unit = EXCLUDED.coverage_unit,
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
      payload.unit ?? null,
      payload.coverage_ratio ?? null,
      payload.coverage_unit ?? null,
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
  COALESCE(pl.unit_type, l.unit_type::text) AS "unitType",
  COALESCE(pl.unit_productivity, l.unit_productivity) AS "unitProductivity",
  COALESCE(pl.productivity_unit, l.productivity_unit) AS "productivityUnit",
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
      company_id, project_id, labor_id, unit_type, unit_productivity, productivity_unit,
      quantity, unit_cost_override, sell_cost_override, notes
    )
    SELECT $1, $2, $3, $4, $5, $6, COALESCE($7, 1), $8, $9, $10
    WHERE EXISTS (SELECT 1 FROM bm_projects WHERE company_id = $1 AND project_id = $2)
      AND EXISTS (SELECT 1 FROM bm_labor WHERE company_id = $1 AND labor_id = $3)
    ON CONFLICT (project_id, labor_id) DO UPDATE SET
      unit_type = EXCLUDED.unit_type,
      unit_productivity = EXCLUDED.unit_productivity,
      productivity_unit = EXCLUDED.productivity_unit,
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
      payload.unit_type ?? null,
      payload.unit_productivity ?? null,
      payload.productivity_unit ?? null,
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
