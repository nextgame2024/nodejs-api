import pool from "../config/db.js";

const NAVIGATION_LINK_SELECT = `
  nl.navigation_link_id AS "navigationLinkId",
  nl.company_id AS "companyId",
  c.company_name AS "companyName",
  nl.user_id AS "userId",
  nl.navigation_type AS "navigationType",
  nl.navigation_label AS "navigationLabel",
  nl.active,
  nl.createdat AS "createdAt",
  nl.updatedat AS "updatedAt"
`;

const withCompanyScope = (where, params, companyId, startIndex = 1) => {
  if (!companyId) return startIndex;
  where.push(`nl.company_id = $${startIndex}`);
  params.push(companyId);
  return startIndex + 1;
};

export async function companyExists(companyId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bm_company WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  return rows.length > 0;
}

export async function listNavigationLinks(
  companyId,
  { q, navigationType, active, limit, offset },
) {
  const params = [];
  const where = [];
  let i = withCompanyScope(where, params, companyId, 1);

  if (navigationType) {
    where.push(`nl.navigation_type = $${i++}`);
    params.push(navigationType);
  }
  if (active !== undefined && active !== null) {
    where.push(`nl.active = $${i++}`);
    params.push(active);
  }
  if (q) {
    where.push(
      `(nl.navigation_label ILIKE $${i} OR nl.navigation_type ILIKE $${i} OR c.company_name ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${NAVIGATION_LINK_SELECT}
    FROM bm_navigation_links nl
    JOIN bm_company c ON c.company_id = nl.company_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      c.company_name ASC NULLS LAST,
      CASE nl.navigation_type
        WHEN 'header' THEN 1
        WHEN 'menu' THEN 2
        ELSE 3
      END,
      nl.navigation_label ASC NULLS LAST,
      nl.createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params,
  );

  return rows;
}

export async function countNavigationLinks(
  companyId,
  { q, navigationType, active },
) {
  const params = [];
  const where = [];
  let i = withCompanyScope(where, params, companyId, 1);

  if (navigationType) {
    where.push(`nl.navigation_type = $${i++}`);
    params.push(navigationType);
  }
  if (active !== undefined && active !== null) {
    where.push(`nl.active = $${i++}`);
    params.push(active);
  }
  if (q) {
    where.push(
      `(nl.navigation_label ILIKE $${i} OR nl.navigation_type ILIKE $${i} OR c.company_name ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }

  const { rows } = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM bm_navigation_links nl
    JOIN bm_company c ON c.company_id = nl.company_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `,
    params,
  );

  return rows[0]?.total ?? 0;
}

export async function getNavigationLink(companyId, navigationLinkId) {
  const params = [navigationLinkId];
  const where = [`nl.navigation_link_id = $1`];

  if (companyId) {
    where.push(`nl.company_id = $2`);
    params.push(companyId);
  }

  const { rows } = await pool.query(
    `
    SELECT ${NAVIGATION_LINK_SELECT}
    FROM bm_navigation_links nl
    JOIN bm_company c ON c.company_id = nl.company_id
    WHERE ${where.join(" AND ")}
    LIMIT 1
    `,
    params,
  );

  return rows[0] ?? null;
}

export async function createNavigationLink(companyId, userId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_navigation_links (
      navigation_link_id,
      company_id,
      user_id,
      navigation_type,
      navigation_label,
      active
    ) VALUES (
      gen_random_uuid(),
      $1,
      $2,
      $3,
      $4,
      COALESCE($5, true)
    )
    RETURNING
      navigation_link_id AS "navigationLinkId"
    `,
    [
      companyId,
      userId,
      payload.navigation_type,
      payload.navigation_label,
      payload.active,
    ],
  );

  return getNavigationLink(companyId, rows[0]?.navigationLinkId);
}

export async function updateNavigationLink(companyId, navigationLinkId, payload) {
  const sets = [];
  const params = [navigationLinkId];
  const where = [`navigation_link_id = $1`];
  let i = 2;

  if (companyId) {
    where.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  const map = {
    company_id: "company_id",
    navigation_type: "navigation_type",
    navigation_label: "navigation_label",
    active: "active",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getNavigationLink(companyId, navigationLinkId);

  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `
    UPDATE bm_navigation_links
    SET ${sets.join(", ")}
    WHERE ${where.join(" AND ")}
    RETURNING navigation_link_id AS "navigationLinkId", company_id AS "companyId"
    `,
    params,
  );

  if (!rows[0]) return null;

  return getNavigationLink(rows[0].companyId, rows[0].navigationLinkId);
}

export async function deleteNavigationLink(companyId, navigationLinkId) {
  const params = [navigationLinkId];
  const where = [`navigation_link_id = $1`];

  if (companyId) {
    where.push(`company_id = $2`);
    params.push(companyId);
  }

  const res = await pool.query(
    `
    DELETE FROM bm_navigation_links
    WHERE ${where.join(" AND ")}
    `,
    params,
  );

  return res.rowCount > 0;
}

export async function listActiveNavigationLinks(companyId, { navigationType }) {
  const params = [companyId];
  const where = [`nl.company_id = $1`, `nl.active = true`];
  let i = 2;

  if (navigationType) {
    where.push(`nl.navigation_type = $${i++}`);
    params.push(navigationType);
  }

  const { rows } = await pool.query(
    `
    SELECT ${NAVIGATION_LINK_SELECT}
    FROM bm_navigation_links nl
    JOIN bm_company c ON c.company_id = nl.company_id
    WHERE ${where.join(" AND ")}
    ORDER BY nl.navigation_label ASC NULLS LAST, nl.createdat DESC
    `,
    params,
  );

  return rows;
}

export async function listNavigationLinksByCompanyAndType(
  companyId,
  navigationType,
) {
  const { rows } = await pool.query(
    `
    SELECT ${NAVIGATION_LINK_SELECT}
    FROM bm_navigation_links nl
    JOIN bm_company c ON c.company_id = nl.company_id
    WHERE nl.company_id = $1
      AND nl.navigation_type = $2
    ORDER BY nl.navigation_label ASC NULLS LAST, nl.createdat DESC
    `,
    [companyId, navigationType],
  );

  return rows;
}

export default {
  companyExists,
  listNavigationLinks,
  countNavigationLinks,
  getNavigationLink,
  createNavigationLink,
  updateNavigationLink,
  deleteNavigationLink,
  listActiveNavigationLinks,
  listNavigationLinksByCompanyAndType,
};
