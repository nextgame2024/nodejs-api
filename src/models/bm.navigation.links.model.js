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

export async function getSophiaAdminEntitlement(companyId, targetUserId) {
  const { rows } = await pool.query(
    `
    SELECT
      u.id::text AS "userId",
      u.name AS "userName",
      u.email::text AS "userEmail",
      u.status::text AS "userStatus",
      c.customer_id::text AS "customerId",
      m.membership_id::text AS "membershipId",
      m.role_key AS "roleKey",
      m.status AS "membershipStatus",
      COALESCE(m.module_scope, ARRAY[]::text[]) AS modules,
      m.authorization_revision AS "authorizationRevision"
    FROM users u
    LEFT JOIN sophia_runtime.customers c
      ON c.external_company_id = u.company_id::text
    LEFT JOIN sophia_runtime.admin_memberships m
      ON m.customer_id = c.customer_id
     AND m.identity_user_id = u.id::text
    WHERE u.company_id = $1
      AND u.id = $2
    LIMIT 1
    `,
    [companyId, targetUserId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    enabled:
      row.roleKey === "client_administrator" &&
      row.membershipStatus === "active" &&
      row.modules.length > 0,
  };
}

export async function hasActiveSophiaAdminEntitlement(companyId, targetUserId) {
  const { rows } = await pool.query(
    `
    SELECT 1
    FROM users u
    JOIN sophia_runtime.customers c
      ON c.external_company_id = u.company_id::text
    JOIN sophia_runtime.admin_memberships m
      ON m.customer_id = c.customer_id
     AND m.identity_user_id = u.id::text
    WHERE u.company_id = $1
      AND u.id = $2
      AND u.status = 'active'
      AND m.status = 'active'
      AND m.role_key = 'client_administrator'
      AND cardinality(m.module_scope) > 0
    LIMIT 1
    `,
    [companyId, targetUserId],
  );
  return rows.length === 1;
}

export async function syncSophiaAdminEntitlement({
  companyId,
  targetUserId,
  actorUserId,
  modules,
  enabled,
}) {
  const entitlements = await syncSophiaAdminEntitlements({
    companyId,
    targetUserIds: [targetUserId],
    actorUserId,
    modules,
    enabled,
  });
  return entitlements[0] ?? null;
}

export async function syncSophiaAdminEntitlements({
  companyId,
  targetUserIds,
  actorUserId,
  modules,
  enabled,
}) {
  const uniqueTargetUserIds = Array.from(
    new Set((targetUserIds ?? []).map((value) => String(value || "").trim()).filter(Boolean)),
  );
  if (!uniqueTargetUserIds.length || uniqueTargetUserIds.length > 100) {
    const error = new Error("Between 1 and 100 target users are required");
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const users = await client.query(
      `SELECT id::text, status::text
       FROM users
       WHERE id = ANY($1::uuid[]) AND company_id = $2
       ORDER BY id
       FOR UPDATE`,
      [uniqueTargetUserIds, companyId],
    );
    if (users.rows.length !== uniqueTargetUserIds.length) {
      const error = new Error("Every selected user must belong to the selected company");
      error.status = 400;
      throw error;
    }
    if (enabled && users.rows.some((user) => user.status !== "active")) {
      const error = new Error("Sophia Admin can only be assigned to an active user");
      error.status = 409;
      throw error;
    }

    const tenant = await client.query(
      `SELECT customer_id::text
       FROM sophia_runtime.customers
       WHERE external_company_id = $1
       LIMIT 2`,
      [companyId],
    );
    if (tenant.rows.length !== 1) {
      const error = new Error("The company must have exactly one Sophia organisation before Admin access can be assigned");
      error.status = 409;
      throw error;
    }
    const customerId = tenant.rows[0].customer_id;
    const current = await client.query(
      `SELECT membership_id::text, identity_user_id, role_key, status, authorization_revision
       FROM sophia_runtime.admin_memberships
       WHERE customer_id = $1::uuid AND identity_user_id = ANY($2::text[])
       ORDER BY identity_user_id
       FOR UPDATE`,
      [customerId, uniqueTargetUserIds],
    );
    const memberships = new Map(current.rows.map((row) => [row.identity_user_id, row]));

    for (const targetUserId of uniqueTargetUserIds) {
      const membership = memberships.get(targetUserId) ?? null;
      const protectedActiveRole =
        enabled && membership?.status === "active" && membership.role_key !== "client_administrator";
      if (protectedActiveRole && uniqueTargetUserIds.length === 1) {
        const error = new Error("The selected user already has a different active Sophia Admin role");
        error.status = 409;
        throw error;
      }
      let changed = false;

      if (enabled && !protectedActiveRole) {
        await client.query(
          `INSERT INTO sophia_runtime.admin_memberships (
             customer_id, identity_user_id, role_key, status,
             permission_overrides, module_scope, authorization_revision
           ) VALUES ($1::uuid, $2, 'client_administrator', 'active',
                     '{"allow":[],"deny":[]}'::jsonb, $3::text[], 1)
           ON CONFLICT (customer_id, identity_user_id) DO UPDATE
           SET role_key = 'client_administrator',
               status = 'active',
               permission_overrides = '{"allow":[],"deny":[]}'::jsonb,
               module_scope = EXCLUDED.module_scope,
               authorization_revision = sophia_runtime.admin_memberships.authorization_revision + 1,
               updated_at = now()`,
          [customerId, targetUserId, modules],
        );
        changed = true;
      } else if (!enabled && membership?.role_key === "client_administrator" && membership.status !== "revoked") {
        await client.query(
          `UPDATE sophia_runtime.admin_memberships
           SET status = 'revoked', module_scope = NULL,
               authorization_revision = authorization_revision + 1,
               updated_at = now()
           WHERE customer_id = $1::uuid AND identity_user_id = $2`,
          [customerId, targetUserId],
        );
        changed = true;
      }

      if (changed) {
        await client.query(
          `INSERT INTO sophia_runtime.admin_audit_events (
             customer_id, identity_user_id, event_type, resource_type,
             resource_id, permission_key, outcome, correlation_id, metadata
           ) VALUES (
             $1::uuid, $2, $3, 'membership', $4, 'users.roles.assign',
             'allowed', 'bm-client-admin-' || gen_random_uuid()::text, $5::jsonb
           )`,
          [
            customerId,
            actorUserId,
            enabled ? "client_admin.entitlement_assigned" : "client_admin.entitlement_revoked",
            targetUserId,
            JSON.stringify({ targetUserId, modules: enabled ? modules : [], source: "business_manager_navigation" }),
          ],
        );
      }
    }
    await client.query("COMMIT");
    return Promise.all(
      uniqueTargetUserIds.map((targetUserId) =>
        getSophiaAdminEntitlement(companyId, targetUserId),
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  getSophiaAdminEntitlement,
  hasActiveSophiaAdminEntitlement,
  syncSophiaAdminEntitlement,
};
