import pool from "../config/db.js";

const SUPPLIER_SELECT = `
  supplier_id AS "supplierId",
  user_id AS "userId",
  supplier_name AS "supplierName",
  address,
  email,
  cel,
  tel,
  notes,
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function listSuppliers(userId, { q, status, limit, offset }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(supplier_name ILIKE $${i} OR email ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${SUPPLIER_SELECT}
    FROM bm_suppliers
    WHERE ${where.join(" AND ")}
    ORDER BY createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countSuppliers(userId, { q, status }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(supplier_name ILIKE $${i} OR email ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM bm_suppliers
     WHERE ${where.join(" AND ")}`,
    params
  );

  return rows[0]?.total ?? 0;
}

export async function getSupplier(userId, supplierId) {
  const { rows } = await pool.query(
    `SELECT ${SUPPLIER_SELECT}
     FROM bm_suppliers
     WHERE user_id = $1 AND supplier_id = $2
     LIMIT 1`,
    [userId, supplierId]
  );
  return rows[0];
}

export async function supplierExists(userId, supplierId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_suppliers WHERE user_id = $1 AND supplier_id = $2 LIMIT 1`,
    [userId, supplierId]
  );
  return rows.length > 0;
}

export async function createSupplier(userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_suppliers (
        supplier_id, user_id, supplier_name, address, email, cel, tel, notes
     ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7
     )
     RETURNING ${SUPPLIER_SELECT}`,
    [
      userId,
      payload.supplier_name,
      payload.address ?? null,
      payload.email ?? null,
      payload.cel ?? null,
      payload.tel ?? null,
      payload.notes ?? null,
    ]
  );
  return rows[0];
}

export async function updateSupplier(userId, supplierId, payload) {
  const sets = [];
  const params = [userId, supplierId];
  let i = 3;

  const map = {
    supplier_name: "supplier_name",
    address: "address",
    email: "email",
    cel: "cel",
    tel: "tel",
    notes: "notes",
    status: "status",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getSupplier(userId, supplierId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_suppliers
     SET ${sets.join(", ")}
     WHERE user_id = $1 AND supplier_id = $2
     RETURNING ${SUPPLIER_SELECT}`,
    params
  );
  return rows[0];
}

export async function archiveSupplier(userId, supplierId) {
  const res = await pool.query(
    `UPDATE bm_suppliers
     SET status = 'archived', updatedat = NOW()
     WHERE user_id = $1 AND supplier_id = $2`,
    [userId, supplierId]
  );
  return res.rowCount > 0;
}

/* Contacts */
const CONTACT_SELECT = `
  id AS "contactId",
  supplier_id AS "supplierId",
  name,
  role_title AS "roleTitle",
  email,
  cel,
  tel,
  createdat AS "createdAt"
`;

export async function listSupplierContacts(userId, supplierId) {
  const { rows } = await pool.query(
    `
    SELECT ${CONTACT_SELECT}
    FROM bm_supplier_contacts c
    JOIN bm_suppliers s ON s.supplier_id = c.supplier_id
    WHERE s.user_id = $1 AND c.supplier_id = $2
    ORDER BY c.createdat DESC
    `,
    [userId, supplierId]
  );
  return rows;
}

export async function createSupplierContact(userId, supplierId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_supplier_contacts (id, supplier_id, name, role_title, email, cel, tel)
    SELECT gen_random_uuid(), $2, $3, $4, $5, $6, $7
    WHERE EXISTS (
      SELECT 1 FROM bm_suppliers WHERE user_id = $1 AND supplier_id = $2
    )
    RETURNING ${CONTACT_SELECT}
    `,
    [
      userId,
      supplierId,
      payload.name,
      payload.role_title ?? null,
      payload.email ?? null,
      payload.cel ?? null,
      payload.tel ?? null,
    ]
  );
  return rows[0] || null;
}

export async function updateSupplierContact(
  userId,
  supplierId,
  contactId,
  payload
) {
  const sets = [];
  const params = [userId, supplierId, contactId];
  let i = 4;

  const map = {
    name: "name",
    role_title: "role_title",
    email: "email",
    cel: "cel",
    tel: "tel",
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
      SELECT ${CONTACT_SELECT}
      FROM bm_supplier_contacts c
      JOIN bm_suppliers s ON s.supplier_id = c.supplier_id
      WHERE s.user_id = $1 AND c.supplier_id = $2 AND c.id = $3
      LIMIT 1
      `,
      [userId, supplierId, contactId]
    );
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `
    UPDATE bm_supplier_contacts c
    SET ${sets.join(", ")}
    FROM bm_suppliers s
    WHERE s.supplier_id = c.supplier_id
      AND s.user_id = $1
      AND c.supplier_id = $2
      AND c.id = $3
    RETURNING ${CONTACT_SELECT}
    `,
    params
  );

  return rows[0] || null;
}

export async function deleteSupplierContact(userId, supplierId, contactId) {
  const res = await pool.query(
    `
    DELETE FROM bm_supplier_contacts c
    USING bm_suppliers s
    WHERE s.supplier_id = c.supplier_id
      AND s.user_id = $1
      AND c.supplier_id = $2
      AND c.id = $3
    `,
    [userId, supplierId, contactId]
  );
  return res.rowCount > 0;
}

/* Supplier ↔ Materials */
const SUPPLIER_MATERIAL_SELECT = `
  sm.supplier_id AS "supplierId",
  sm.material_id AS "materialId",
  sm.supplier_sku AS "supplierSku",
  sm.lead_time_days AS "leadTimeDays",
  sm.unit_cost_override AS "unitCostOverride",
  sm.createdat AS "createdAt"
`;

export async function listSupplierMaterials(userId, supplierId) {
  const { rows } = await pool.query(
    `
    SELECT ${SUPPLIER_MATERIAL_SELECT}
    FROM bm_supplier_materials sm
    JOIN bm_suppliers s ON s.supplier_id = sm.supplier_id
    JOIN bm_materials m ON m.material_id = sm.material_id
    WHERE s.user_id = $1 AND sm.supplier_id = $2 AND m.user_id = $1
    ORDER BY sm.createdat DESC
    `,
    [userId, supplierId]
  );
  return rows;
}

export async function addSupplierMaterial(userId, supplierId, payload) {
  // Ensure: supplier belongs to user; material belongs to user
  const { rows } = await pool.query(
    `
    INSERT INTO bm_supplier_materials (
      supplier_id, material_id, supplier_sku, lead_time_days, unit_cost_override
    )
    SELECT $2, $3, $4, $5, $6
    WHERE EXISTS (SELECT 1 FROM bm_suppliers WHERE user_id = $1 AND supplier_id = $2)
      AND EXISTS (SELECT 1 FROM bm_materials WHERE user_id = $1 AND material_id = $3)
    ON CONFLICT (supplier_id, material_id) DO UPDATE SET
      supplier_sku = EXCLUDED.supplier_sku,
      lead_time_days = EXCLUDED.lead_time_days,
      unit_cost_override = EXCLUDED.unit_cost_override
    RETURNING
      supplier_id AS "supplierId",
      material_id AS "materialId",
      supplier_sku AS "supplierSku",
      lead_time_days AS "leadTimeDays",
      unit_cost_override AS "unitCostOverride",
      createdat AS "createdAt"
    `,
    [
      userId,
      supplierId,
      payload.material_id,
      payload.supplier_sku ?? null,
      payload.lead_time_days ?? null,
      payload.unit_cost_override ?? null,
    ]
  );

  return rows[0] || null;
}

export async function updateSupplierMaterial(
  userId,
  supplierId,
  materialId,
  payload
) {
  const sets = [];
  const params = [userId, supplierId, materialId];
  let i = 4;

  const map = {
    supplier_sku: "supplier_sku",
    lead_time_days: "lead_time_days",
    unit_cost_override: "unit_cost_override",
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
      SELECT ${SUPPLIER_MATERIAL_SELECT}
      FROM bm_supplier_materials sm
      JOIN bm_suppliers s ON s.supplier_id = sm.supplier_id
      JOIN bm_materials m ON m.material_id = sm.material_id
      WHERE s.user_id = $1 AND sm.supplier_id = $2 AND sm.material_id = $3 AND m.user_id = $1
      LIMIT 1
      `,
      [userId, supplierId, materialId]
    );
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `
    UPDATE bm_supplier_materials sm
    SET ${sets.join(", ")}
    FROM bm_suppliers s, bm_materials m
    WHERE sm.supplier_id = s.supplier_id
      AND sm.material_id = m.material_id
      AND s.user_id = $1
      AND m.user_id = $1
      AND sm.supplier_id = $2
      AND sm.material_id = $3
    RETURNING
      sm.supplier_id AS "supplierId",
      sm.material_id AS "materialId",
      sm.supplier_sku AS "supplierSku",
      sm.lead_time_days AS "leadTimeDays",
      sm.unit_cost_override AS "unitCostOverride",
      sm.createdat AS "createdAt"
    `,
    params
  );

  return rows[0] || null;
}

export async function removeSupplierMaterial(userId, supplierId, materialId) {
  const res = await pool.query(
    `
    DELETE FROM bm_supplier_materials sm
    USING bm_suppliers s, bm_materials m
    WHERE sm.supplier_id = s.supplier_id
      AND sm.material_id = m.material_id
      AND s.user_id = $1
      AND m.user_id = $1
      AND sm.supplier_id = $2
      AND sm.material_id = $3
    `,
    [userId, supplierId, materialId]
  );
  return res.rowCount > 0;
}
