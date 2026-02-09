// src/models/bm.documents.model.js
import pool from "../config/db.js";

const DOC_SELECT = `
  d.document_id AS "documentId",
  d.company_id AS "companyId",
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
  d.pdf_url AS "pdfUrl",
  d.pdf_key AS "pdfKey",
  d.invoice_status AS "invoiceStatus",
  d.status,
  d.createdat AS "createdAt",
  d.updatedat AS "updatedAt"
`;

const COMPANY_SELECT = `
  company_id AS "companyId",
  legal_name AS "legalName",
  trading_name AS "tradingName",
  abn,
  address,
  email,
  COALESCE(phone, tel, cel) AS "phone",
  logo_url AS "logoUrl"
`;

export async function getCompanyProfile(companyId) {
  const { rows } = await pool.query(
    `
    SELECT ${COMPANY_SELECT}
    FROM bm_company
    WHERE company_id = $1
    LIMIT 1
    `,
    [companyId]
  );
  return rows[0] || null;
}

export async function documentExists(companyId, documentId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_documents WHERE company_id = $1 AND document_id = $2 LIMIT 1`,
    [companyId, documentId]
  );
  return rows.length > 0;
}

export async function listDocuments(
  companyId,
  { q, status, type, clientId, projectId, limit, offset }
) {
  const params = [companyId];
  let i = 2;
  const where = [`d.company_id = $1`];

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
    JOIN bm_clients c
      ON c.client_id = d.client_id
     AND c.company_id = d.company_id
    LEFT JOIN bm_projects p
      ON p.project_id = d.project_id
     AND p.company_id = d.company_id
    WHERE ${where.join(" AND ")}
    ORDER BY d.createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countDocuments(
  companyId,
  { q, status, type, clientId, projectId }
) {
  const params = [companyId];
  let i = 2;
  const where = [`d.company_id = $1`];

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
    JOIN bm_clients c
      ON c.client_id = d.client_id
     AND c.company_id = d.company_id
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  return rows[0]?.total ?? 0;
}

export async function getDocument(companyId, documentId) {
  const { rows } = await pool.query(
    `
    SELECT ${DOC_SELECT}
    FROM bm_documents d
    JOIN bm_clients c
      ON c.client_id = d.client_id
     AND c.company_id = d.company_id
    LEFT JOIN bm_projects p
      ON p.project_id = d.project_id
     AND p.company_id = d.company_id
    WHERE d.company_id = $1 AND d.document_id = $2
    LIMIT 1
    `,
    [companyId, documentId]
  );
  return rows[0];
}

export async function createDocument(companyId, userId, payload) {
  // Validate client belongs to company; validate project (if provided) belongs to company.
  // Optional (recommended): project must belong to same client if provided.
  const { rows } = await pool.query(
    `
    INSERT INTO bm_documents (
      document_id, company_id, user_id, client_id, project_id, type, doc_number,
      issue_date, due_date, notes, status
    )
    SELECT
      gen_random_uuid(), $1, $2, $3, $4, $5, $6,
      COALESCE($7, CURRENT_DATE), $8, $9, COALESCE($10, 'draft')
    WHERE EXISTS (
      SELECT 1 FROM bm_clients
      WHERE company_id = $1 AND client_id = $3
    )
    AND (
      $4 IS NULL
      OR EXISTS (
        SELECT 1 FROM bm_projects
        WHERE company_id = $1
          AND project_id = $4
          AND client_id = $3
      )
    )
    RETURNING document_id
    `,
    [
      companyId,
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
  return getDocument(companyId, rows[0].document_id);
}

export async function updateDocument(companyId, documentId, payload) {
  const sets = [];
  const params = [companyId, documentId];
  let i = 3;

  const map = {
    client_id: "client_id",
    project_id: "project_id",
    type: "type",
    doc_number: "doc_number",
    issue_date: "issue_date",
    due_date: "due_date",
    notes: "notes",
    pdf_url: "pdf_url",
    pdf_key: "pdf_key",
    invoice_status: "invoice_status",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      if (k === "client_id") {
        // must belong to same company
        sets.push(
          `${col} = (SELECT client_id FROM bm_clients WHERE company_id = $1 AND client_id = $${i})`
        );
        params.push(payload[k]);
        i++;
        continue;
      }

      if (k === "project_id") {
        // allow null, else must belong to company (and ideally match client_id)
        // NOTE: if client_id is also being updated in this request, we can’t reference the new value safely here.
        // We keep it safe by validating company scope only. (Client/project pairing is enforced on create.)
        sets.push(
          `${col} = CASE
            WHEN $${i} IS NULL THEN NULL
            ELSE (SELECT project_id FROM bm_projects WHERE company_id = $1 AND project_id = $${i})
          END`
        );
        params.push(payload[k]);
        i++;
        continue;
      }

      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getDocument(companyId, documentId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_documents
    SET ${sets.join(", ")}
    WHERE company_id = $1 AND document_id = $2
    RETURNING document_id
    `,
    params
  );

  return rows[0] ? getDocument(companyId, documentId) : null;
}

export async function archiveDocument(companyId, documentId) {
  // "archive deletes": we set status instead of deleting
  const res = await pool.query(
    `UPDATE bm_documents
     SET status = 'void', updatedat = NOW()
     WHERE company_id = $1 AND document_id = $2`,
    [companyId, documentId]
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

export async function listDocumentMaterialLines(companyId, documentId) {
  const { rows } = await pool.query(
    `
    SELECT ${MAT_LINE_SELECT}
    FROM bm_document_material_lines l
    JOIN bm_documents d
      ON d.document_id = l.document_id
     AND d.company_id = l.company_id
    LEFT JOIN bm_materials m
      ON m.material_id = l.material_id
     AND m.company_id = d.company_id
    WHERE d.company_id = $1 AND l.document_id = $2
    ORDER BY l.line_id ASC
    `,
    [companyId, documentId]
  );
  return rows;
}

export async function createDocumentMaterialLine(
  companyId,
  documentId,
  payload
) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_document_material_lines (
      line_id, company_id, document_id, material_id, description, quantity, unit_price, line_total
    )
    SELECT
      gen_random_uuid(),
      $1,
      $2,
      $3,
      $4,
      COALESCE($5, 1),
      $6,
      (COALESCE($5, 1) * $6)
    WHERE EXISTS (
      SELECT 1 FROM bm_documents
      WHERE company_id = $1 AND document_id = $2
    )
    AND (
      $3 IS NULL
      OR EXISTS (
        SELECT 1 FROM bm_materials
        WHERE company_id = $1 AND material_id = $3
      )
    )
    RETURNING line_id
    `,
    [
      companyId,
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
    JOIN bm_documents d
      ON d.document_id = l.document_id
     AND d.company_id = l.company_id
    LEFT JOIN bm_materials m
      ON m.material_id = l.material_id
     AND m.company_id = d.company_id
    WHERE d.company_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [companyId, documentId, rows[0].line_id]
  );
  return out[0] || null;
}

export async function updateDocumentMaterialLine(
  companyId,
  documentId,
  lineId,
  payload
) {
  const sets = [];
  const params = [companyId, documentId, lineId];
  let i = 4;

  // For material_id, validate company scope
  if (payload.material_id !== undefined) {
    sets.push(
      `material_id = CASE
        WHEN $${i} IS NULL THEN NULL
        ELSE (SELECT material_id FROM bm_materials WHERE company_id = $1 AND material_id = $${i})
      END`
    );
    params.push(payload.material_id);
    i++;
  }

  const map = {
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
      JOIN bm_documents d
        ON d.document_id = l.document_id
       AND d.company_id = l.company_id
      LEFT JOIN bm_materials m
        ON m.material_id = l.material_id
       AND m.company_id = d.company_id
      WHERE d.company_id = $1 AND l.document_id = $2 AND l.line_id = $3
      LIMIT 1
      `,
      [companyId, documentId, lineId]
    );
    return rows[0] || null;
  }

  const sql = `
    UPDATE bm_document_material_lines l
    SET ${sets.join(", ")},
        line_total = (COALESCE(quantity, 1) * COALESCE(unit_price, 0))
    FROM bm_documents d
    WHERE d.document_id = l.document_id
      AND d.company_id = $1
      AND l.company_id = $1
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
    JOIN bm_documents d
      ON d.document_id = l.document_id
     AND d.company_id = l.company_id
    LEFT JOIN bm_materials m
      ON m.material_id = l.material_id
     AND m.company_id = d.company_id
    WHERE d.company_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [companyId, documentId, lineId]
  );
  return out[0] || null;
}

export async function deleteDocumentMaterialLine(
  companyId,
  documentId,
  lineId
) {
  const res = await pool.query(
    `
    DELETE FROM bm_document_material_lines l
    USING bm_documents d
    WHERE d.document_id = l.document_id
      AND d.company_id = $1
      AND l.company_id = $1
      AND l.document_id = $2
      AND l.line_id = $3
    `,
    [companyId, documentId, lineId]
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

export async function listDocumentLaborLines(companyId, documentId) {
  const { rows } = await pool.query(
    `
    SELECT ${LAB_LINE_SELECT}
    FROM bm_document_labor_lines l
    JOIN bm_documents d
      ON d.document_id = l.document_id
     AND d.company_id = l.company_id
    LEFT JOIN bm_labor lb
      ON lb.labor_id = l.labor_id
     AND lb.company_id = d.company_id
    WHERE d.company_id = $1 AND l.document_id = $2
    ORDER BY l.line_id ASC
    `,
    [companyId, documentId]
  );
  return rows;
}

export async function createDocumentLaborLine(companyId, documentId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_document_labor_lines (
      line_id, company_id, document_id, labor_id, description, quantity, unit_type, unit_price, line_total
    )
    SELECT
      gen_random_uuid(),
      $1,
      $2,
      $3,
      $4,
      COALESCE($5, 1),
      $6,
      $7,
      (COALESCE($5, 1) * $7)
    WHERE EXISTS (
      SELECT 1 FROM bm_documents
      WHERE company_id = $1 AND document_id = $2
    )
    AND (
      $3 IS NULL
      OR EXISTS (
        SELECT 1 FROM bm_labor
        WHERE company_id = $1 AND labor_id = $3
      )
    )
    RETURNING line_id
    `,
    [
      companyId,
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
    JOIN bm_documents d
      ON d.document_id = l.document_id
     AND d.company_id = l.company_id
    LEFT JOIN bm_labor lb
      ON lb.labor_id = l.labor_id
     AND lb.company_id = d.company_id
    WHERE d.company_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [companyId, documentId, rows[0].line_id]
  );
  return out[0] || null;
}

export async function updateDocumentLaborLine(
  companyId,
  documentId,
  lineId,
  payload
) {
  const sets = [];
  const params = [companyId, documentId, lineId];
  let i = 4;

  // For labor_id, validate company scope
  if (payload.labor_id !== undefined) {
    sets.push(
      `labor_id = CASE
        WHEN $${i} IS NULL THEN NULL
        ELSE (SELECT labor_id FROM bm_labor WHERE company_id = $1 AND labor_id = $${i})
      END`
    );
    params.push(payload.labor_id);
    i++;
  }

  const map = {
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
      JOIN bm_documents d
        ON d.document_id = l.document_id
       AND d.company_id = l.company_id
      LEFT JOIN bm_labor lb
        ON lb.labor_id = l.labor_id
       AND lb.company_id = d.company_id
      WHERE d.company_id = $1 AND l.document_id = $2 AND l.line_id = $3
      LIMIT 1
      `,
      [companyId, documentId, lineId]
    );
    return rows[0] || null;
  }

  const sql = `
    UPDATE bm_document_labor_lines l
    SET ${sets.join(", ")},
        line_total = (COALESCE(quantity, 1) * COALESCE(unit_price, 0))
    FROM bm_documents d
    WHERE d.document_id = l.document_id
      AND d.company_id = $1
      AND l.company_id = $1
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
    JOIN bm_documents d
      ON d.document_id = l.document_id
     AND d.company_id = l.company_id
    LEFT JOIN bm_labor lb
      ON lb.labor_id = l.labor_id
     AND lb.company_id = d.company_id
    WHERE d.company_id = $1 AND l.document_id = $2 AND l.line_id = $3
    LIMIT 1
    `,
    [companyId, documentId, lineId]
  );
  return out[0] || null;
}

export async function deleteDocumentLaborLine(companyId, documentId, lineId) {
  const res = await pool.query(
    `
    DELETE FROM bm_document_labor_lines l
    USING bm_documents d
    WHERE d.document_id = l.document_id
      AND d.company_id = $1
      AND l.company_id = $1
      AND l.document_id = $2
      AND l.line_id = $3
    `,
    [companyId, documentId, lineId]
  );
  return res.rowCount > 0;
}

/* Totals recalculation
   GST rate resolution priority:
   1) Project pricing profile gst_rate (if project exists and default_pricing=false and pricing_profile_id set)
   2) Most recent active pricing profile for company
   3) Fallback 0.10
*/
export async function recalcDocumentTotals(companyId, documentId) {
  const { rows: docRows } = await pool.query(
    `SELECT document_id, project_id
     FROM bm_documents
     WHERE company_id = $1 AND document_id = $2
     LIMIT 1`,
    [companyId, documentId]
  );
  if (!docRows[0]) return null;

  const projectId = docRows[0].project_id;

  let materialTotal = 0;
  let laborTotal = 0;

  if (projectId) {
    const { rows: projRows } = await pool.query(
      `
      SELECT default_pricing, cost_in_quote
      FROM bm_projects
      WHERE company_id = $1 AND project_id = $2
      LIMIT 1
      `,
      [companyId, projectId]
    );

    const project = projRows[0];

    if (project && project.cost_in_quote === false) {
      const { materialMarkup, laborMarkup } = await resolvePricing(
        pool,
        companyId,
        projectId
      );

      const { rows: matRows } = await pool.query(
        `
        SELECT COALESCE(
          SUM(
            (CASE
              WHEN p.project_type_id IS NULL THEN pm.quantity
              ELSE COALESCE(p.meters_required, 0) / NULLIF(COALESCE(pm.coverage_ratio, 0), 0)
            END)
            *
            CASE
              WHEN p.project_type_id IS NOT NULL THEN
                CASE
                  WHEN p.default_pricing = true THEN
                    COALESCE(pm.sell_cost_override, pm.unit_cost_override, 0) / NULLIF(COALESCE(pm.quantity, 0), 0)
                  ELSE
                    COALESCE(pm.unit_cost_override, 0) / NULLIF(COALESCE(pm.quantity, 0), 0) * (1::numeric + $3::numeric)
                END
              WHEN p.default_pricing = true THEN COALESCE(pm.sell_cost_override, pm.unit_cost_override, 0)
              ELSE COALESCE(pm.unit_cost_override, 0) * (1::numeric + $3::numeric)
            END
          ), 0
        )::numeric(12,2) AS material_total
        FROM bm_project_materials pm
        JOIN bm_projects p
          ON p.project_id = pm.project_id
         AND p.company_id = pm.company_id
        WHERE p.company_id = $1
          AND p.project_id = $2
          AND pm.company_id = $1
        `,
        [companyId, projectId, materialMarkup]
      );

      const { rows: labRows } = await pool.query(
        `
        SELECT COALESCE(
          SUM(
            (CASE
              WHEN p.project_type_id IS NULL THEN pl.quantity
              ELSE COALESCE(p.meters_required, 0) / NULLIF(COALESCE(pl.unit_productivity, l.unit_productivity, 0), 0)
            END)
            *
            CASE
              WHEN p.default_pricing = true THEN COALESCE(pl.sell_cost_override, l.sell_cost, l.unit_cost, 0)
              ELSE COALESCE(pl.unit_cost_override, l.unit_cost, 0) * (1::numeric + $3::numeric)
            END
          ), 0
        )::numeric(12,2) AS labor_total
        FROM bm_project_labor pl
        JOIN bm_projects p
          ON p.project_id = pl.project_id
         AND p.company_id = pl.company_id
        JOIN bm_labor l
          ON l.labor_id = pl.labor_id
         AND l.company_id = p.company_id
        WHERE p.company_id = $1
          AND p.project_id = $2
          AND pl.company_id = $1
        `,
        [companyId, projectId, laborMarkup]
      );

      materialTotal = Number(matRows[0]?.material_total ?? 0);
      laborTotal = Number(labRows[0]?.labor_total ?? 0);
    } else {
      const { rows: sumRows } = await pool.query(
        `
        WITH mat AS (
          SELECT COALESCE(SUM(line_total),0)::numeric(12,2) AS material_total
          FROM bm_document_material_lines
          WHERE company_id = $1 AND document_id = $2
        ),
        lab AS (
          SELECT COALESCE(SUM(line_total),0)::numeric(12,2) AS labor_total
          FROM bm_document_labor_lines
          WHERE company_id = $1 AND document_id = $2
        )
        SELECT mat.material_total, lab.labor_total
        FROM mat, lab
        `,
        [companyId, documentId]
      );

      materialTotal = Number(sumRows[0]?.material_total ?? 0);
      laborTotal = Number(sumRows[0]?.labor_total ?? 0);
    }
  } else {
    const { rows: sumRows } = await pool.query(
      `
      WITH mat AS (
        SELECT COALESCE(SUM(line_total),0)::numeric(12,2) AS material_total
        FROM bm_document_material_lines
        WHERE company_id = $1 AND document_id = $2
      ),
      lab AS (
        SELECT COALESCE(SUM(line_total),0)::numeric(12,2) AS labor_total
        FROM bm_document_labor_lines
        WHERE company_id = $1 AND document_id = $2
      )
      SELECT mat.material_total, lab.labor_total
      FROM mat, lab
      `,
      [companyId, documentId]
    );

    materialTotal = Number(sumRows[0]?.material_total ?? 0);
    laborTotal = Number(sumRows[0]?.labor_total ?? 0);
  }
  const subtotal = Number(materialTotal) + Number(laborTotal);

  const { rows: gstRows } = await pool.query(
    `
    SELECT
      COALESCE(
        (
          SELECT pp.gst_rate
          FROM bm_projects p
          JOIN bm_pricing_profiles pp
            ON pp.pricing_profile_id = p.pricing_profile_id
           AND pp.company_id = p.company_id
          WHERE p.company_id = $1
            AND p.project_id = $2
            AND p.default_pricing = false
            AND p.pricing_profile_id IS NOT NULL
            AND pp.status = 'active'
          LIMIT 1
        ),
        (
          SELECT gst_rate
          FROM bm_pricing_profiles
          WHERE company_id = $1 AND status = 'active'
          ORDER BY updatedat DESC NULLS LAST, createdat DESC
          LIMIT 1
        ),
        0.10
      )::numeric(7,4) AS gst_rate
    `,
    [companyId, projectId]
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
    WHERE company_id = $1 AND document_id = $2
    `,
    [
      companyId,
      documentId,
      materialTotal,
      laborTotal,
      subtotal,
      gst,
      totalAmount,
    ]
  );

  return getDocument(companyId, documentId);
}

/* ---- Optional helpers for future features (doc number + create from project) ---- */

// Allocate next doc number in a transaction.
// bm_doc_counters PK is (company_id, doc_type)
async function allocateDocNumber(client, companyId, userId, docType) {
  const { rows } = await client.query(
    `
      INSERT INTO bm_doc_counters (company_id, user_id, doc_type, next_number)
      VALUES ($1, $2, $3, 2)
      ON CONFLICT (company_id, doc_type)
      DO UPDATE SET next_number = bm_doc_counters.next_number + 1
      RETURNING (bm_doc_counters.next_number - 1) AS allocated
    `,
    [companyId, userId ?? null, docType]
  );

  const n = rows[0]?.allocated ?? 1;
  const prefix = docType === "quote" ? "Q" : "I";
  const padded = String(n).padStart(6, "0");
  return `${prefix}-${padded}`;
}

async function resolvePricing(client, companyId, projectId) {
  const { rows } = await client.query(
    `
      SELECT
        COALESCE(
          (
            SELECT pp.material_markup
            FROM bm_projects p
            JOIN bm_pricing_profiles pp
              ON pp.pricing_profile_id = p.pricing_profile_id
             AND pp.company_id = p.company_id
            WHERE p.company_id = $1
              AND p.project_id = $2
              AND p.default_pricing = false
              AND p.pricing_profile_id IS NOT NULL
              AND pp.status = 'active'
            LIMIT 1
          ),
          (
            SELECT material_markup
            FROM bm_pricing_profiles
            WHERE company_id = $1 AND status = 'active'
            ORDER BY updatedat DESC NULLS LAST, createdat DESC
            LIMIT 1
          ),
          0
        )::numeric(7,4) AS material_markup,
        COALESCE(
          (
            SELECT pp.labor_markup
            FROM bm_projects p
            JOIN bm_pricing_profiles pp
              ON pp.pricing_profile_id = p.pricing_profile_id
             AND pp.company_id = p.company_id
            WHERE p.company_id = $1
              AND p.project_id = $2
              AND p.default_pricing = false
              AND p.pricing_profile_id IS NOT NULL
              AND pp.status = 'active'
            LIMIT 1
          ),
          (
            SELECT labor_markup
            FROM bm_pricing_profiles
            WHERE company_id = $1 AND status = 'active'
            ORDER BY updatedat DESC NULLS LAST, createdat DESC
            LIMIT 1
          ),
          0
        )::numeric(7,4) AS labor_markup
    `,
    [companyId, projectId]
  );

  return {
    materialMarkup: Number(rows[0]?.material_markup ?? 0),
    laborMarkup: Number(rows[0]?.labor_markup ?? 0),
  };
}

// Not currently routed, but kept ready for next phase.
export async function createDocumentFromProject(
  companyId,
  userId,
  projectId,
  payload
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: projRows } = await client.query(
      `
        SELECT project_id, client_id
        FROM bm_projects
        WHERE company_id = $1 AND project_id = $2
        LIMIT 1
      `,
      [companyId, projectId]
    );
    if (!projRows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const docType = payload.type;
    if (docType !== "quote" && docType !== "invoice") {
      const err = new Error("type must be quote or invoice");
      err.statusCode = 400;
      throw err;
    }

    const clientId = projRows[0].client_id;

    let documentId = null;
    let docNumber = null;

    if (docType === "invoice") {
      const { rows: existingRows } = await client.query(
        `
          SELECT document_id, doc_number
          FROM bm_documents
          WHERE company_id = $1
            AND project_id = $2
            AND type = 'invoice'
          ORDER BY createdat ASC
          LIMIT 1
        `,
        [companyId, projectId]
      );
      if (existingRows[0]) {
        documentId = existingRows[0].document_id;
        docNumber = existingRows[0].doc_number;

        await client.query(
          `
          UPDATE bm_documents
          SET issue_date = COALESCE($3, issue_date),
              due_date = COALESCE($4, due_date),
              notes = COALESCE($5, notes),
              status = COALESCE($6, status),
              invoice_status = COALESCE($7, invoice_status),
              updatedat = NOW()
          WHERE company_id = $1 AND document_id = $2
          `,
          [
            companyId,
            documentId,
            payload.issue_date ?? null,
            payload.due_date ?? null,
            payload.notes ?? null,
            payload.status ?? null,
            payload.invoice_status ?? null,
          ]
        );

        await client.query(
          `DELETE FROM bm_document_material_lines WHERE company_id = $1 AND document_id = $2`,
          [companyId, documentId]
        );
        await client.query(
          `DELETE FROM bm_document_labor_lines WHERE company_id = $1 AND document_id = $2`,
          [companyId, documentId]
        );
      }
    }

    if (docType === "quote") {
      const { rows: existingRows } = await client.query(
        `
          SELECT document_id, doc_number
          FROM bm_documents
          WHERE company_id = $1
            AND project_id = $2
            AND type = 'quote'
          ORDER BY createdat ASC
          LIMIT 1
        `,
        [companyId, projectId]
      );
      if (existingRows[0]) {
        documentId = existingRows[0].document_id;
        docNumber = existingRows[0].doc_number;

        await client.query(
          `
          UPDATE bm_documents
          SET issue_date = COALESCE($3, issue_date),
              due_date = COALESCE($4, due_date),
              notes = COALESCE($5, notes),
              status = COALESCE($6, status),
              updatedat = NOW()
          WHERE company_id = $1 AND document_id = $2
          `,
          [
            companyId,
            documentId,
            payload.issue_date ?? null,
            payload.due_date ?? null,
            payload.notes ?? null,
            payload.status ?? null,
          ]
        );

        await client.query(
          `DELETE FROM bm_document_material_lines WHERE company_id = $1 AND document_id = $2`,
          [companyId, documentId]
        );
        await client.query(
          `DELETE FROM bm_document_labor_lines WHERE company_id = $1 AND document_id = $2`,
          [companyId, documentId]
        );
      }
    }

    if (!documentId) {
      docNumber =
        payload.doc_number && String(payload.doc_number).trim()
          ? String(payload.doc_number).trim()
          : await allocateDocNumber(client, companyId, userId, docType);

      const { rows: docRows } = await client.query(
        `
          INSERT INTO bm_documents (
            document_id, company_id, user_id, client_id, project_id, type, doc_number,
            issue_date, due_date, notes, status, invoice_status
          )
          VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5::bm_doc_type, $6,
            COALESCE($7, CURRENT_DATE), $8, $9, COALESCE($10, 'draft')::bm_doc_status,
            CASE
              WHEN $5::bm_doc_type = 'invoice'::bm_doc_type
                THEN COALESCE($11, 'invoice_created'::bm_invoice_status)
              ELSE NULL
            END
          )
          RETURNING document_id
        `,
        [
          companyId,
          userId,
          clientId,
          projectId,
          docType,
          docNumber,
          payload.issue_date ?? null,
          payload.due_date ?? null,
          payload.notes ?? null,
          payload.status ?? null,
          payload.invoice_status ?? null,
        ]
      );

      documentId = docRows[0].document_id;
    }

    if (docType === "invoice") {
      await client.query(
        `
        UPDATE bm_documents
        SET invoice_status = COALESCE(invoice_status, 'invoice_created'::bm_invoice_status)
        WHERE company_id = $1 AND document_id = $2
        `,
        [companyId, documentId]
      );
    }

    const { materialMarkup, laborMarkup } = await resolvePricing(
      client,
      companyId,
      projectId
    );

    await client.query(
      `
        INSERT INTO bm_document_material_lines (
          line_id, company_id, document_id, material_id, description, quantity, unit_price, line_total
        )
        SELECT
          gen_random_uuid(),
          $1,
          $3,
          pm.material_id,
          m.material_name,
          CASE
            WHEN p.project_type_id IS NULL THEN pm.quantity
            ELSE COALESCE(p.meters_required, 0) / NULLIF(COALESCE(pm.coverage_ratio, 0), 0)
          END AS quantity,
          CASE
            WHEN p.cost_in_quote = false THEN 0
            WHEN p.project_type_id IS NOT NULL THEN
              CASE
                WHEN p.default_pricing = true THEN
                  COALESCE(pm.sell_cost_override, pm.unit_cost_override, 0) / NULLIF(COALESCE(pm.quantity, 0), 0)
                ELSE
                  COALESCE(pm.unit_cost_override, 0) / NULLIF(COALESCE(pm.quantity, 0), 0) * (1::numeric + $4::numeric)
              END
            WHEN p.default_pricing = true THEN COALESCE(pm.sell_cost_override, pm.unit_cost_override, 0)
            ELSE COALESCE(ROUND((pm.unit_cost_override * (1::numeric + $4::numeric))::numeric, 2), 0)
          END AS unit_price,
          ROUND(
            (
              (CASE
                WHEN p.project_type_id IS NULL THEN pm.quantity
                ELSE COALESCE(p.meters_required, 0) / NULLIF(COALESCE(pm.coverage_ratio, 0), 0)
              END)
              *
              CASE
                WHEN p.cost_in_quote = false THEN 0
                WHEN p.project_type_id IS NOT NULL THEN
                  CASE
                    WHEN p.default_pricing = true THEN
                      COALESCE(pm.sell_cost_override, pm.unit_cost_override, 0) / NULLIF(COALESCE(pm.quantity, 0), 0)
                    ELSE
                      COALESCE(pm.unit_cost_override, 0) / NULLIF(COALESCE(pm.quantity, 0), 0) * (1::numeric + $4::numeric)
                  END
                WHEN p.default_pricing = true THEN COALESCE(pm.sell_cost_override, pm.unit_cost_override, 0)
                ELSE COALESCE((pm.unit_cost_override * (1::numeric + $4::numeric)), 0)
              END
            )::numeric,
            2
          ) AS line_total
        FROM bm_project_materials pm
        JOIN bm_projects p
          ON p.project_id = pm.project_id
         AND p.company_id = pm.company_id
        JOIN bm_materials m
          ON m.material_id = pm.material_id
         AND m.company_id = p.company_id
        WHERE p.company_id = $1
          AND p.project_id = $2
          AND pm.company_id = $1
      `,
      [companyId, projectId, documentId, materialMarkup]
    );

    await client.query(
      `
        INSERT INTO bm_document_labor_lines (
          line_id, company_id, document_id, labor_id, description, quantity, unit_type, unit_price, line_total
        )
        SELECT
          gen_random_uuid(),
          $1,
          $3,
          pl.labor_id,
          l.labor_name,
          CASE
            WHEN p.project_type_id IS NULL THEN pl.quantity
            ELSE COALESCE(p.meters_required, 0) / NULLIF(COALESCE(pl.unit_productivity, l.unit_productivity, 0), 0)
          END AS quantity,
          COALESCE(pl.unit_type, l.unit_type),
          CASE
            WHEN p.cost_in_quote = false THEN 0
            WHEN p.default_pricing = true THEN COALESCE(pl.sell_cost_override, l.sell_cost, l.unit_cost, 0)
            ELSE COALESCE(ROUND((COALESCE(pl.unit_cost_override, l.unit_cost) * (1::numeric + $4::numeric))::numeric, 2), 0)
          END AS unit_price,
          ROUND(
            (
              (CASE
                WHEN p.project_type_id IS NULL THEN pl.quantity
                ELSE COALESCE(p.meters_required, 0) / NULLIF(COALESCE(pl.unit_productivity, l.unit_productivity, 0), 0)
              END)
              *
              CASE
                WHEN p.cost_in_quote = false THEN 0
                WHEN p.default_pricing = true THEN COALESCE(pl.sell_cost_override, l.sell_cost, l.unit_cost, 0)
                ELSE COALESCE((COALESCE(pl.unit_cost_override, l.unit_cost) * (1::numeric + $4::numeric)), 0)
              END
            )::numeric,
            2
          ) AS line_total
        FROM bm_project_labor pl
        JOIN bm_projects p
          ON p.project_id = pl.project_id
         AND p.company_id = pl.company_id
        JOIN bm_labor l
          ON l.labor_id = pl.labor_id
         AND l.company_id = p.company_id
        WHERE p.company_id = $1
          AND p.project_id = $2
          AND pl.company_id = $1
      `,
      [companyId, projectId, documentId, laborMarkup]
    );

    await client.query("COMMIT");

    const document = await getDocument(companyId, documentId);
    const materialLines = await listDocumentMaterialLines(
      companyId,
      documentId
    );
    const laborLines = await listDocumentLaborLines(companyId, documentId);
    const finalDoc = await recalcDocumentTotals(companyId, documentId);

    return {
      document: finalDoc || document,
      materialLines,
      laborLines,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}
