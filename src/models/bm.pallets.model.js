import pool from "../config/db.js";
import { ensureSitesSchema, SITE_SELECT } from "./bm.sites.model.js";

let schemaReady = false;

const MOVEMENT_SELECT = `
  p.pallet_id AS "palletId",
  p.company_id AS "companyId",
  p.user_id AS "userId",
  p.origin_site_id AS "originSiteId",
  os.site_name AS "originSiteName",
  os.administrator AS "originAdministrator",
  os.address AS "originAddress",
  os.email AS "originEmail",
  os.mobile AS "originMobile",
  p.destination_site_id AS "destinationSiteId",
  ds.site_name AS "destinationSiteName",
  ds.administrator AS "destinationAdministrator",
  ds.address AS "destinationAddress",
  ds.email AS "destinationEmail",
  ds.mobile AS "destinationMobile",
  p.pallets,
  p.status,
  p.createdat AS "createdAt",
  p.updatedat AS "updatedAt",
  p.receivedat AS "receivedAt"
`;

export async function ensurePalletsSchema() {
  if (schemaReady) return;
  await ensureSitesSchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bm_pallets (
      pallet_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      user_id uuid NULL,
      origin_site_id uuid NOT NULL REFERENCES bm_sites(site_id),
      destination_site_id uuid NOT NULL REFERENCES bm_sites(site_id),
      pallets integer NOT NULL CHECK (pallets > 0),
      status text NOT NULL DEFAULT 'in_transit',
      createdat timestamptz NOT NULL DEFAULT now(),
      updatedat timestamptz NULL,
      receivedat timestamptz NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bm_pallets_company_origin
      ON bm_pallets (company_id, origin_site_id, status, createdat DESC);
    CREATE INDEX IF NOT EXISTS idx_bm_pallets_company_destination
      ON bm_pallets (company_id, destination_site_id, status, createdat DESC);
  `);
  schemaReady = true;
}

export async function getCurrentUserSite(companyId, userId) {
  await ensurePalletsSchema();
  const { rows } = await pool.query(
    `
    SELECT ${SITE_SELECT}
    FROM bm_sites
    WHERE company_id = $1
      AND status = 'active'
      AND (user_id = $2 OR user_id IS NULL)
    ORDER BY (user_id = $2) DESC, createdat ASC
    LIMIT 1
    `,
    [companyId, userId],
  );
  return rows[0] ?? null;
}

export async function listOnSite(companyId, { q, limit, offset }) {
  await ensurePalletsSchema();
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`, `status = 'active'`];
  if (q) {
    where.push(
      `(site_name ILIKE $${i} OR administrator ILIKE $${i} OR address ILIKE $${i} OR email ILIKE $${i} OR mobile ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `
    SELECT ${SITE_SELECT}
    FROM bm_sites
    WHERE ${where.join(" AND ")}
    ORDER BY LOWER(site_name) ASC NULLS LAST
    LIMIT $${i++} OFFSET $${i}
    `,
    params,
  );
  return rows;
}

export async function countOnSite(companyId, { q }) {
  await ensurePalletsSchema();
  const params = [companyId];
  let i = 2;
  const where = [`company_id = $1`, `status = 'active'`];
  if (q) {
    where.push(
      `(site_name ILIKE $${i} OR administrator ILIKE $${i} OR address ILIKE $${i} OR email ILIKE $${i} OR mobile ILIKE $${i})`,
    );
    params.push(`%${q}%`);
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM bm_sites WHERE ${where.join(" AND ")}`,
    params,
  );
  return rows[0]?.total ?? 0;
}

export async function listDestinations(companyId, originSiteId) {
  await ensurePalletsSchema();
  const { rows } = await pool.query(
    `
    SELECT ${SITE_SELECT}
    FROM bm_sites
    WHERE company_id = $1
      AND status = 'active'
      AND site_id <> $2
    ORDER BY LOWER(site_name) ASC NULLS LAST
    `,
    [companyId, originSiteId],
  );
  return rows;
}

export async function listSent(companyId, originSiteId, { limit, offset }) {
  await ensurePalletsSchema();
  const { rows } = await pool.query(
    `
    SELECT ${MOVEMENT_SELECT}
    FROM bm_pallets p
    JOIN bm_sites os ON os.site_id = p.origin_site_id AND os.company_id = p.company_id
    JOIN bm_sites ds ON ds.site_id = p.destination_site_id AND ds.company_id = p.company_id
    WHERE p.company_id = $1
      AND p.origin_site_id = $2
      AND p.status = 'in_transit'
    ORDER BY p.createdat DESC
    LIMIT $3 OFFSET $4
    `,
    [companyId, originSiteId, limit, offset],
  );
  return rows;
}

export async function countSent(companyId, originSiteId) {
  await ensurePalletsSchema();
  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_pallets
    WHERE company_id = $1 AND origin_site_id = $2 AND status = 'in_transit'
    `,
    [companyId, originSiteId],
  );
  return rows[0]?.total ?? 0;
}

export async function listIncoming(companyId, destinationSiteId, { limit, offset }) {
  await ensurePalletsSchema();
  const { rows } = await pool.query(
    `
    SELECT ${MOVEMENT_SELECT}
    FROM bm_pallets p
    JOIN bm_sites os ON os.site_id = p.origin_site_id AND os.company_id = p.company_id
    JOIN bm_sites ds ON ds.site_id = p.destination_site_id AND ds.company_id = p.company_id
    WHERE p.company_id = $1
      AND p.destination_site_id = $2
      AND p.status = 'in_transit'
    ORDER BY p.createdat DESC
    LIMIT $3 OFFSET $4
    `,
    [companyId, destinationSiteId, limit, offset],
  );
  return rows;
}

export async function countIncoming(companyId, destinationSiteId) {
  await ensurePalletsSchema();
  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_pallets
    WHERE company_id = $1 AND destination_site_id = $2 AND status = 'in_transit'
    `,
    [companyId, destinationSiteId],
  );
  return rows[0]?.total ?? 0;
}

export async function movePallets(companyId, userId, payload) {
  await ensurePalletsSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const originSiteId = payload.origin_site_id ?? payload.originSiteId;
    const destinationSiteId =
      payload.destination_site_id ?? payload.destinationSiteId;
    const pallets = Number(payload.pallets ?? payload.pallets_sent);
    if (!originSiteId || !destinationSiteId || !Number.isInteger(pallets) || pallets <= 0) {
      const err = new Error("origin_site_id, destination_site_id, and pallets are required");
      err.status = 400;
      throw err;
    }
    if (originSiteId === destinationSiteId) {
      const err = new Error("Destination site must be different from origin site");
      err.status = 400;
      throw err;
    }

    const origin = await client.query(
      `
      SELECT site_id, pallets_onsite
      FROM bm_sites
      WHERE company_id = $1 AND site_id = $2 AND status = 'active'
      FOR UPDATE
      `,
      [companyId, originSiteId],
    );
    if (!origin.rows[0]) {
      const err = new Error("Origin site not found");
      err.status = 404;
      throw err;
    }
    if (Number(origin.rows[0].pallets_onsite) < pallets) {
      const err = new Error("The origin site does not have enough pallets to move.");
      err.status = 400;
      throw err;
    }

    const destination = await client.query(
      `SELECT site_id FROM bm_sites WHERE company_id = $1 AND site_id = $2 AND status = 'active' LIMIT 1`,
      [companyId, destinationSiteId],
    );
    if (!destination.rows[0]) {
      const err = new Error("Destination site not found");
      err.status = 404;
      throw err;
    }

    await client.query(
      `
      UPDATE bm_sites
      SET pallets_onsite = pallets_onsite - $3, updatedat = NOW()
      WHERE company_id = $1 AND site_id = $2
      `,
      [companyId, originSiteId, pallets],
    );

    const { rows } = await client.query(
      `
      INSERT INTO bm_pallets (
        pallet_id, company_id, user_id, origin_site_id, destination_site_id, pallets
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5
      )
      RETURNING pallet_id AS "palletId"
      `,
      [companyId, userId, originSiteId, destinationSiteId, pallets],
    );
    await client.query("COMMIT");
    return getMovement(companyId, rows[0].palletId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteMovement(companyId, userId, palletId) {
  await ensurePalletsSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const movement = await client.query(
      `
      SELECT pallet_id, origin_site_id, pallets
      FROM bm_pallets
      WHERE company_id = $1 AND pallet_id = $2 AND status = 'in_transit'
      FOR UPDATE
      `,
      [companyId, palletId],
    );
    if (!movement.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `
      UPDATE bm_sites
      SET pallets_onsite = pallets_onsite + $3, updatedat = NOW()
      WHERE company_id = $1 AND site_id = $2
      `,
      [companyId, movement.rows[0].origin_site_id, movement.rows[0].pallets],
    );
    await client.query(
      `
      UPDATE bm_pallets
      SET status = 'cancelled', updatedat = NOW()
      WHERE company_id = $1 AND pallet_id = $2
      `,
      [companyId, palletId],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function receiveMovement(companyId, userId, palletId) {
  await ensurePalletsSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const movement = await client.query(
      `
      SELECT pallet_id, destination_site_id, pallets
      FROM bm_pallets
      WHERE company_id = $1 AND pallet_id = $2 AND status = 'in_transit'
      FOR UPDATE
      `,
      [companyId, palletId],
    );
    if (!movement.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
      UPDATE bm_sites
      SET pallets_onsite = pallets_onsite + $3, updatedat = NOW()
      WHERE company_id = $1 AND site_id = $2
      `,
      [companyId, movement.rows[0].destination_site_id, movement.rows[0].pallets],
    );
    await client.query(
      `
      UPDATE bm_pallets
      SET status = 'received', receivedat = NOW(), updatedat = NOW()
      WHERE company_id = $1 AND pallet_id = $2
      `,
      [companyId, palletId],
    );
    await client.query("COMMIT");
    return { palletId, status: "received" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getMovement(companyId, palletId) {
  const { rows } = await pool.query(
    `
    SELECT ${MOVEMENT_SELECT}
    FROM bm_pallets p
    JOIN bm_sites os ON os.site_id = p.origin_site_id AND os.company_id = p.company_id
    JOIN bm_sites ds ON ds.site_id = p.destination_site_id AND ds.company_id = p.company_id
    WHERE p.company_id = $1 AND p.pallet_id = $2
    LIMIT 1
    `,
    [companyId, palletId],
  );
  return rows[0] ?? null;
}
