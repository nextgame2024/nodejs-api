import pool from "../config/db.js";

const CLIENT_SELECT = `
  client_id AS "clientId",
  company_id AS "companyId",
  user_id AS "userId",
  client_name AS "clientName",
  address,
  email,
  cel,
  tel,
  notes,
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function listClients(companyId, { q, status, limit, offset }) {
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(client_name ILIKE $${i} OR email ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${CLIENT_SELECT}
    FROM bm_clients
    WHERE ${where.join(" AND ")}
    ORDER BY client_name ASC NULLS LAST, createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countClients(companyId, { q, status }) {
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`];

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(`(client_name ILIKE $${i} OR email ILIKE $${i})`);
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_clients
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  return rows[0]?.total ?? 0;
}

export async function getClient(companyId, clientId) {
  const { rows } = await pool.query(
    `
    SELECT ${CLIENT_SELECT}
    FROM bm_clients
    WHERE company_id = $1 AND client_id = $2
    LIMIT 1
    `,
    [companyId, clientId]
  );
  return rows[0];
}

export async function clientExists(companyId, clientId) {
  const { rows } = await pool.query(
    `
    SELECT 1
    FROM bm_clients
    WHERE company_id = $1 AND client_id = $2
    LIMIT 1
    `,
    [companyId, clientId]
  );
  return rows.length > 0;
}

export async function createClient(companyId, userId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_clients (
      client_id, company_id, user_id, client_name, address, email, cel, tel, notes
    ) VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8
    )
    RETURNING ${CLIENT_SELECT}
    `,
    [
      companyId,
      userId,
      payload.client_name,
      payload.address ?? null,
      payload.email ?? null,
      payload.cel ?? null,
      payload.tel ?? null,
      payload.notes ?? null,
    ]
  );
  return rows[0];
}

export async function updateClient(companyId, clientId, payload) {
  const sets = [];
  const params = [companyId, clientId];
  let i = 3;

  const map = {
    client_name: "client_name",
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

  if (!sets.length) return getClient(companyId, clientId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_clients
    SET ${sets.join(", ")}
    WHERE company_id = $1 AND client_id = $2
    RETURNING ${CLIENT_SELECT}
    `,
    params
  );

  return rows[0] || null;
}

export async function archiveClient(companyId, clientId) {
  const res = await pool.query(
    `
    UPDATE bm_clients
    SET status = 'archived', updatedat = NOW()
    WHERE company_id = $1 AND client_id = $2
    `,
    [companyId, clientId]
  );
  return res.rowCount > 0;
}

/* Contacts */

// For SELECT/UPDATE queries where we DO have alias `c`
const CONTACT_SELECT = `
  c.id AS "contactId",
  c.company_id AS "companyId",
  c.client_id AS "clientId",
  c.name,
  c.role_title AS "roleTitle",
  c.email,
  c.cel,
  c.tel,
  c.createdat AS "createdAt"
`;

// For INSERT ... RETURNING (NO alias allowed)
const CONTACT_RETURNING = `
  id AS "contactId",
  company_id AS "companyId",
  client_id AS "clientId",
  name,
  role_title AS "roleTitle",
  email,
  cel,
  tel,
  createdat AS "createdAt"
`;

export async function listClientContacts(
  companyId,
  clientId,
  { limit, offset }
) {
  const { rows } = await pool.query(
    `
    SELECT ${CONTACT_SELECT}
    FROM bm_client_contacts c
    JOIN bm_clients cl ON cl.client_id = c.client_id
    WHERE cl.company_id = $1
      AND c.company_id = $1
      AND c.client_id = $2
    ORDER BY c.name ASC NULLS LAST, c.createdat DESC
    LIMIT $3 OFFSET $4
    `,
    [companyId, clientId, limit, offset]
  );
  return rows;
}

export async function countClientContacts(companyId, clientId) {
  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_client_contacts c
    JOIN bm_clients cl ON cl.client_id = c.client_id
    WHERE cl.company_id = $1
      AND c.company_id = $1
      AND c.client_id = $2
    `,
    [companyId, clientId]
  );
  return rows[0]?.total ?? 0;
}

export async function createClientContact(companyId, clientId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_client_contacts (
      id, company_id, client_id, name, role_title, email, cel, tel
    )
    SELECT gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7
    WHERE EXISTS (
      SELECT 1 FROM bm_clients WHERE company_id = $1 AND client_id = $2
    )
    RETURNING ${CONTACT_RETURNING}
    `,
    [
      companyId,
      clientId,
      payload.name,
      payload.role_title ?? null,
      payload.email ?? null,
      payload.cel ?? null,
      payload.tel ?? null,
    ]
  );
  return rows[0] || null;
}

export async function updateClientContact(
  companyId,
  clientId,
  contactId,
  payload
) {
  const sets = [];
  const params = [companyId, clientId, contactId];
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
      sets.push(`c.${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) {
    const { rows } = await pool.query(
      `
      SELECT ${CONTACT_SELECT}
      FROM bm_client_contacts c
      JOIN bm_clients cl ON cl.client_id = c.client_id
      WHERE cl.company_id = $1
        AND c.company_id = $1
        AND c.client_id = $2
        AND c.id = $3
      LIMIT 1
      `,
      [companyId, clientId, contactId]
    );
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `
    UPDATE bm_client_contacts c
    SET ${sets.join(", ")}
    FROM bm_clients cl
    WHERE cl.client_id = c.client_id
      AND cl.company_id = $1
      AND c.company_id = $1
      AND c.client_id = $2
      AND c.id = $3
    RETURNING ${CONTACT_SELECT}
    `,
    params
  );

  return rows[0] || null;
}

export async function deleteClientContact(companyId, clientId, contactId) {
  const res = await pool.query(
    `
    DELETE FROM bm_client_contacts c
    USING bm_clients cl
    WHERE cl.client_id = c.client_id
      AND cl.company_id = $1
      AND c.company_id = $1
      AND c.client_id = $2
      AND c.id = $3
    `,
    [companyId, clientId, contactId]
  );
  return res.rowCount > 0;
}

export default {
  listClients,
  countClients,
  getClient,
  clientExists,
  createClient,
  updateClient,
  archiveClient,
  listClientContacts,
  countClientContacts,
  createClientContact,
  updateClientContact,
  deleteClientContact,
};
