import pool from "../config/db.js";

const DOC_SELECT = `
  d.document_id AS "documentId",
  d.user_id AS "userId",
  d.client_id AS "clientId",
  c.client_name AS "clientName",
  d.project_id AS "projectId",
  p.project_name AS "projectName",
  d.type,
  d.doc_number AS "docNumber",
  d.issue_date AS "issueDate",
  d.due_date AS "dueDate",
  d.notes,
  d.material_total AS "materialTotal",
  d.labor_total AS "laborTotal",
  d.subtotal,
  d.gst,
  d.total_amount AS "totalAmount",
  d.status,
  d.createdat AS "createdAt",
  d.updatedat AS "updatedAt"
`;

export async function documentExists(userId, documentId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_documents WHERE user_id = $1 AND document_id = $2 LIMIT 1`,
    [userId, documentId]
  );
  return rows.length > 0;
}

export async function listDocuments(
  userId,
  { q, status, type, clientId, projectId, limit, offset }
) {
  const params = [userId];
  let i = 2;
  const where = [`d.user_id = $1`];

  if (status) {
    where.push(`d.status = $${i++}`);
    params.push(status);
  }
  if (type) {
    where.push(`d.type = $${i++}`);
    params.push(type);
  }
  if (clientId) {
    where.push(`d.client_id = $${i++}`);
    params.push(clientId);
  }
  if (projectId) {
    where.push(`d.project_id = $${i++}`);
    params.push(projectId);
  }
  if (q) {
    where.push(`(c.client_name ILIKE $${i} OR d.doc_number ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${DOC_SELECT}
    FROM bm_documents d
    JOIN bm_clients c ON c.client_id = d.client_id
    LEFT JOIN bm_projects p ON p.project_id = d.project_id
    WHERE ${where.join(" AND ")}
    ORDER BY d.createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countDocuments(
  userId,
  { q, status, type, clientId, projectId }
) {
  const params = [userId];
  let i = 2;
  const where = [`d.user_id = $1`];

  if (status) {
    where.push(`d.status = $${i++}`);
    params.push(status);
  }
  if (type) {
    where.push(`d.type = $${i++}`);
    params.push(type);
  }
  if (clientId) {
    where.push(`d.client_id = $${i++}`);
    params.push(clientId);
  }
  if (projectId) {
    where.push(`d.project_id = $${i++}`);
    params.push(projectId);
  }
  if (q) {
    where.push(`(c.client_name ILIKE $${i} OR d.doc_number ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_documents d
    JOIN bm_clients c ON c.client_id = d.client_id
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  return rows[0]?.total ?? 0;
}

export async function getDocument(userId, documentId) {
  const { rows } = await pool.query(
    `
    SELECT ${DOC_SELECT}
    FROM bm_documents d
    JOIN bm_clients c ON c.client_id = d.client_id
    LEFT JOIN bm_projects p ON p.project_id = d.project_id
    WHERE d.user_id = $1 AND d.document_id = $2
    LIMIT 1
    `,
    [userId, documentId]
  );
  return rows[0];
}

export async function createDocument(userId, payload) {
  // Validate client belongs to user; validate project (if provided) belongs to user and matches client (optional rule).
  const { rows } = await pool.query(
    `
    INSERT INTO bm_documents (
      document_id, user_id, client_id, project_id, type, doc_number,
      issue_date, due_date, notes, status
    )
    SELECT
      gen_random_uuid(), $1, $2, $3, $4, $5,
      COALESCE($6, CURRENT_DATE), $7, $8, COALESCE($9, 'draft')
    WHERE EXISTS (SELECT 1 FROM bm_clients WHERE user_id = $1 AND client_id = $2)
      AND (
        $3 IS NULL
        OR EXISTS (SELECT 1 FROM bm_projects WHERE user_id = $1 AND project_id = $3)
      )
    RETURNING document_id
    `,
    [
      userId,
      payload.client_id,
      payload.project_id ?? null,
      payload.type,
      payload.doc_number ?? null,
      payload.issue_date ?? null,
      payload.due_date ?? null,
      payload.notes ?? null,
      payload.status ?? null,
    ]
  );

  if (!rows[0]) return null;
  return getDocument(userId, rows[0].document_id);
}

export async function updateDocument(userId, documentId, payload) {
  const sets = [];
  const params = [userId, documentId];
  let i = 3;

  const map = {
    client_id: "client_id",
    project_id: "project_id",
    type: "type",
    doc_number: "doc_number",
    issue_date: "issue_date",
    due_date: "due_date",
    notes: "notes",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      if (k === "client_id") {
        // must belong to user
        sets.push(
          `${col} = (SELECT client_id FROM bm_clients WHERE user_id = $1 AND client_id = $${i})`
        );
        params.push(payload[k]);
        i++;
        continue;
      }
      if (k === "project_id") {
        // allow null, else must belong to user
        sets.push(`${col} = CASE WHEN $${i} IS NULL THEN NULL
          ELSE (SELECT project_id FROM bm_projects WHERE user_id = $1 AND project_id = $${i}) END`);
        params.push(payload[k]);
        i++;
        continue;
      }
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getDocument(userId, documentId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_documents
    SET ${sets.join(", ")}
    WHERE user_id = $1 AND document_id = $2
    RETURNING document_id
    `,
    params
  );

  return rows[0] ? getDocument(userId, documentId) : null;
}

export async function archiveDocument(userId, documentId) {
  const res = await pool.query(
    `UPDATE bm_documents SET status = 'void', updatedat = NOW()
     WHERE user_id = $1 AND document_id = $2`,
    [userId, documentId]
  );
  return res.rowCount > 0;
}

/* Material lines */
const MAT_LINE_SELECT = `
  l.line_id AS "lineId",
  l.document_id AS "documentId",
  l.material_id AS "materialId",
  m.material_name AS "materialName",
  l.description,
  l.quantity,
  l.unit_price AS "unitPrice",
  l.line_total AS "lineTotal"
`;

export async function listDocumentMaterialLines(userId, documentId) {
  const { rows } = await pool.query(
    `
    SELECT ${MAT_LINE_SELECT}
    FROM bm_document_material_lines l
    JOIN bm_documents d ON d.document_id = l.document_id
    LEFT JOIN bm_materials m ON m.material_id = l.material_id
    WHERE d.user_id = $1 AND l.document_id = $2
    ORDER BY l.line_id ASC
    `,
    [userId, documentId]
  );
  return rows;
}

export async function createDocumentMaterialLine(userId, documentId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_document_material_lines (
      line_id, document_id, material_id, description, quantity, unit_price, line_total
    )
    SELECT
      gen_random_uuid(), $2, $3, $4, COALESCE($5, 1), $6, (COALESCE($5, 1) * $6)
    WHERE EXISTS (SELECT 1 FROM bm_documents WHERE user_id = $1 AND document_id = $2)
    RETURNING line_id
    `,
    [
      userId,
      documentId,
      payload.material_id ?? null,
      payload.description ?? null,
      payload.quantity ?? 1,
      payload.unit_price,
    ]
  );

  if (!rows[0]) return null;

  const { rows: out } = await pool.query(
    `
    SELECT ${MAT_LINE_SELECT}
    FROM bm_document_material_lines l
    JOIN bm_documents d ON d.document_id = l.document_id
    LEFT JOIN bm_materials m ON m.material_id = l.material_id
    WHERE d.user_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [userId, documentId, rows[0].line_id]
  );
  return out[0] || null;
}

export async function updateDocumentMaterialLine(
  userId,
  documentId,
  lineId,
  payload
) {
  const sets = [];
  const params = [userId, documentId, lineId];
  let i = 4;

  const map = {
    material_id: "material_id",
    description: "description",
    quantity: "quantity",
    unit_price: "unit_price",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) {
    const { rows } = await pool.query(
      `
      SELECT ${MAT_LINE_SELECT}
      FROM bm_document_material_lines l
      JOIN bm_documents d ON d.document_id = l.document_id
      LEFT JOIN bm_materials m ON m.material_id = l.material_id
      WHERE d.user_id = $1 AND l.document_id = $2 AND l.line_id = $3
      LIMIT 1
      `,
      [userId, documentId, lineId]
    );
    return rows[0] || null;
  }

  // ensure line_total stays consistent
  const sql = `
    UPDATE bm_document_material_lines l
    SET ${sets.join(", ")},
        line_total = (COALESCE(quantity, 1) * COALESCE(unit_price, 0))
    FROM bm_documents d
    WHERE d.document_id = l.document_id
      AND d.user_id = $1
      AND l.document_id = $2
      AND l.line_id = $3
    RETURNING l.line_id
  `;

  const { rows } = await pool.query(sql, params);
  if (!rows[0]) return null;

  const { rows: out } = await pool.query(
    `
    SELECT ${MAT_LINE_SELECT}
    FROM bm_document_material_lines l
    JOIN bm_documents d ON d.document_id = l.document_id
    LEFT JOIN bm_materials m ON m.material_id = l.material_id
    WHERE d.user_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [userId, documentId, lineId]
  );
  return out[0] || null;
}

export async function deleteDocumentMaterialLine(userId, documentId, lineId) {
  const res = await pool.query(
    `
    DELETE FROM bm_document_material_lines l
    USING bm_documents d
    WHERE d.document_id = l.document_id
      AND d.user_id = $1
      AND l.document_id = $2
      AND l.line_id = $3
    `,
    [userId, documentId, lineId]
  );
  return res.rowCount > 0;
}

/* Labor lines */
const LAB_LINE_SELECT = `
  l.line_id AS "lineId",
  l.document_id AS "documentId",
  l.labor_id AS "laborId",
  lb.labor_name AS "laborName",
  l.description,
  l.quantity,
  l.unit_type AS "unitType",
  l.unit_price AS "unitPrice",
  l.line_total AS "lineTotal"
`;

export async function listDocumentLaborLines(userId, documentId) {
  const { rows } = await pool.query(
    `
    SELECT ${LAB_LINE_SELECT}
    FROM bm_document_labor_lines l
    JOIN bm_documents d ON d.document_id = l.document_id
    LEFT JOIN bm_labor lb ON lb.labor_id = l.labor_id
    WHERE d.user_id = $1 AND l.document_id = $2
    ORDER BY l.line_id ASC
    `,
    [userId, documentId]
  );
  return rows;
}

export async function createDocumentLaborLine(userId, documentId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_document_labor_lines (
      line_id, document_id, labor_id, description, quantity, unit_type, unit_price, line_total
    )
    SELECT
      gen_random_uuid(), $2, $3, $4, COALESCE($5, 1), $6, $7, (COALESCE($5, 1) * $7)
    WHERE EXISTS (SELECT 1 FROM bm_documents WHERE user_id = $1 AND document_id = $2)
    RETURNING line_id
    `,
    [
      userId,
      documentId,
      payload.labor_id ?? null,
      payload.description ?? null,
      payload.quantity ?? 1,
      payload.unit_type ?? null,
      payload.unit_price,
    ]
  );

  if (!rows[0]) return null;

  const { rows: out } = await pool.query(
    `
    SELECT ${LAB_LINE_SELECT}
    FROM bm_document_labor_lines l
    JOIN bm_documents d ON d.document_id = l.document_id
    LEFT JOIN bm_labor lb ON lb.labor_id = l.labor_id
    WHERE d.user_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [userId, documentId, rows[0].line_id]
  );
  return out[0] || null;
}

export async function updateDocumentLaborLine(
  userId,
  documentId,
  lineId,
  payload
) {
  const sets = [];
  const params = [userId, documentId, lineId];
  let i = 4;

  const map = {
    labor_id: "labor_id",
    description: "description",
    quantity: "quantity",
    unit_type: "unit_type",
    unit_price: "unit_price",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) {
    const { rows } = await pool.query(
      `
      SELECT ${LAB_LINE_SELECT}
      FROM bm_document_labor_lines l
      JOIN bm_documents d ON d.document_id = l.document_id
      LEFT JOIN bm_labor lb ON lb.labor_id = l.labor_id
      WHERE d.user_id = $1 AND l.document_id = $2 AND l.line_id = $3
      LIMIT 1
      `,
      [userId, documentId, lineId]
    );
    return rows[0] || null;
  }

  const sql = `
    UPDATE bm_document_labor_lines l
    SET ${sets.join(", ")},
        line_total = (COALESCE(quantity, 1) * COALESCE(unit_price, 0))
    FROM bm_documents d
    WHERE d.document_id = l.document_id
      AND d.user_id = $1
      AND l.document_id = $2
      AND l.line_id = $3
    RETURNING l.line_id
  `;

  const { rows } = await pool.query(sql, params);
  if (!rows[0]) return null;

  const { rows: out } = await pool.query(
    `
    SELECT ${LAB_LINE_SELECT}
    FROM bm_document_labor_lines l
    JOIN bm_documents d ON d.document_id = l.document_id
    LEFT JOIN bm_labor lb ON lb.labor_id = l.labor_id
    WHERE d.user_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [userId, documentId, lineId]
  );
  return out[0] || null;
}

export async function deleteDocumentLaborLine(userId, documentId, lineId) {
  const res = await pool.query(
    `
    DELETE FROM bm_document_labor_lines l
    USING bm_documents d
    WHERE d.document_id = l.document_id
      AND d.user_id = $1
      AND l.document_id = $2
      AND l.line_id = $3
    `,
    [userId, documentId, lineId]
  );
  return res.rowCount > 0;
}

/* Totals recalculation
   GST rate resolution priority:
   1) Project pricing profile gst_rate (if project exists and default_pricing=false and pricing_profile_id set)
   2) User default pricing profile (is_default=true, active)
   3) Fallback 0.10
*/
export async function recalcDocumentTotals(userId, documentId) {
  const { rows: docRows } = await pool.query(
    `SELECT document_id, project_id FROM bm_documents WHERE user_id = $1 AND document_id = $2 LIMIT 1`,
    [userId, documentId]
  );
  if (!docRows[0]) return null;

  const projectId = docRows[0].project_id;

  const { rows: sumRows } = await pool.query(
    `
    WITH mat AS (
      SELECT COALESCE(SUM(line_total),0)::numeric(12,2) AS material_total
      FROM bm_document_material_lines
      WHERE document_id = $1
    ),
    lab AS (
      SELECT COALESCE(SUM(line_total),0)::numeric(12,2) AS labor_total
      FROM bm_document_labor_lines
      WHERE document_id = $1
    )
    SELECT mat.material_total, lab.labor_total
    FROM mat, lab
    `,
    [documentId]
  );

  const materialTotal = sumRows[0].material_total;
  const laborTotal = sumRows[0].labor_total;
  const subtotal = Number(materialTotal) + Number(laborTotal);

  // Resolve GST rate
  const { rows: gstRows } = await pool.query(
    `
    SELECT
      COALESCE(
        (
          SELECT pp.gst_rate
          FROM bm_projects p
          JOIN bm_pricing_profiles pp ON pp.pricing_profile_id = p.pricing_profile_id
          WHERE p.user_id = $1
            AND p.project_id = $2
            AND p.default_pricing = false
            AND p.pricing_profile_id IS NOT NULL
            AND pp.status = 'active'
          LIMIT 1
        ),
        (
          SELECT gst_rate
          FROM bm_pricing_profiles
          WHERE user_id = $1 AND is_default = true AND status = 'active'
          ORDER BY updatedat DESC
          LIMIT 1
        ),
        0.10
      )::numeric(7,4) AS gst_rate
    `,
    [userId, projectId]
  );

  const gstRate = Number(gstRows[0].gst_rate);
  const gst = +(subtotal * gstRate).toFixed(2);
  const totalAmount = +(subtotal + gst).toFixed(2);

  await pool.query(
    `
    UPDATE bm_documents
    SET material_total = $3,
        labor_total = $4,
        subtotal = $5,
        gst = $6,
        total_amount = $7,
        updatedat = NOW()
    WHERE user_id = $1 AND document_id = $2
    `,
    [userId, documentId, materialTotal, laborTotal, subtotal, gst, totalAmount]
  );

  return getDocument(userId, documentId);
}
