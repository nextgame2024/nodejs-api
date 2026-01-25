import pool from "../config/db.js";

const CLIENT_SELECT = `
  client_id AS "clientId",
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

export async function listClients(userId, { q, status, limit, offset }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

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
    ORDER BY createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params
  );

  return rows;
}

export async function countClients(userId, { q, status }) {
  const params = [userId];
  let i = 2;
  const where = [`user_id = $1`];

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
    `SELECT COUNT(*)::int AS total
     FROM bm_clients
     WHERE ${where.join(" AND ")}`,
    params
  );

  return rows[0]?.total ?? 0;
}

export async function getClient(userId, clientId) {
  const { rows } = await pool.query(
    `SELECT ${CLIENT_SELECT}
     FROM bm_clients
     WHERE user_id = $1 AND client_id = $2
     LIMIT 1`,
    [userId, clientId]
  );
  return rows[0];
}

export async function clientExists(userId, clientId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_clients WHERE user_id = $1 AND client_id = $2 LIMIT 1`,
    [userId, clientId]
  );
  return rows.length > 0;
}

export async function createClient(userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_clients (
        client_id, user_id, client_name, address, email, cel, tel, notes
     ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7
     )
     RETURNING ${CLIENT_SELECT}`,
    [
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

export async function updateClient(userId, clientId, payload) {
  const sets = [];
  const params = [userId, clientId];
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

  if (!sets.length) return getClient(userId, clientId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_clients
     SET ${sets.join(", ")}
     WHERE user_id = $1 AND client_id = $2
     RETURNING ${CLIENT_SELECT}`,
    params
  );
  return rows[0];
}

export async function archiveClient(userId, clientId) {
  const res = await pool.query(
    `UPDATE bm_clients
     SET status = 'archived', updatedat = NOW()
     WHERE user_id = $1 AND client_id = $2`,
    [userId, clientId]
  );
  return res.rowCount > 0;
}

/* Contacts */
const CONTACT_SELECT = `
  id AS "contactId",
  client_id AS "clientId",
  name,
  role_title AS "roleTitle",
  email,
  cel,
  tel,
  createdat AS "createdAt"
`;

export async function listClientContacts(userId, clientId) {
  const { rows } = await pool.query(
    `
      SELECT ${CONTACT_SELECT}
      FROM bm_client_contacts c
      JOIN bm_clients cl ON cl.client_id = c.client_id
      WHERE cl.user_id = $1 AND c.client_id = $2
      ORDER BY c.createdat DESC
      `,
    [userId, clientId]
  );
  return rows;
}

export async function createClientContact(userId, clientId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_client_contacts (id, client_id, name, role_title, email, cel, tel)
    SELECT gen_random_uuid(), $2, $3, $4, $5, $6, $7
    WHERE EXISTS (
      SELECT 1 FROM bm_clients WHERE user_id = $1 AND client_id = $2
    )
    RETURNING ${CONTACT_SELECT}
    `,
    [
      userId,
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
  userId,
  clientId,
  contactId,
  payload
) {
  const sets = [];
  const params = [userId, clientId, contactId];
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
      FROM bm_client_contacts c
      JOIN bm_clients cl ON cl.client_id = c.client_id
      WHERE cl.user_id = $1 AND c.client_id = $2 AND c.id = $3
      LIMIT 1
      `,
      [userId, clientId, contactId]
    );
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `
    UPDATE bm_client_contacts c
    SET ${sets.join(", ")}
    FROM bm_clients cl
    WHERE cl.client_id = c.client_id
      AND cl.user_id = $1
      AND c.client_id = $2
      AND c.id = $3
    RETURNING ${CONTACT_SELECT}
    `,
    params
  );

  return rows[0] || null;
}

export async function deleteClientContact(userId, clientId, contactId) {
  const res = await pool.query(
    `
    DELETE FROM bm_client_contacts c
    USING bm_clients cl
    WHERE cl.client_id = c.client_id
      AND cl.user_id = $1
      AND c.client_id = $2
      AND c.id = $3
    `,
    [userId, clientId, contactId]
  );
  return res.rowCount > 0;
}
