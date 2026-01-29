/* Contacts */
const CONTACT_SELECT = `
  c.id AS "contactId",
  c.client_id AS "clientId",
  c.name,
  c.role_title AS "roleTitle",
  c.email,
  c.cel,
  c.tel,
  c.createdat AS "createdAt"
`;

export async function listClientContacts(companyId, clientId) {
  const { rows } = await pool.query(
    `
    SELECT ${CONTACT_SELECT}
    FROM bm_client_contacts c
    JOIN bm_clients cl ON cl.client_id = c.client_id
    WHERE cl.company_id = $1
      AND c.client_id = $2
    ORDER BY c.createdat DESC
    `,
    [companyId, clientId]
  );
  return rows;
}

export async function createClientContact(companyId, clientId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_client_contacts (id, client_id, company_id, name, role_title, email, cel, tel)
    SELECT gen_random_uuid(), $2, $1, $3, $4, $5, $6, $7
    WHERE EXISTS (
      SELECT 1
      FROM bm_clients
      WHERE company_id = $1 AND client_id = $2
    )
    RETURNING ${CONTACT_SELECT}
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
      AND c.client_id = $2
      AND c.id = $3
    `,
    [companyId, clientId, contactId]
  );
  return res.rowCount > 0;
}
