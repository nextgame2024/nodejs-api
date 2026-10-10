import pool from "../config/db.js";
import { ensureSitesSchema } from "./bm.sites.model.js";

let usersSiteSchemaReady = false;

export async function ensureUsersSiteSchema() {
  if (usersSiteSchemaReady) return;
  await ensureSitesSchema();
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS site_id uuid NULL,
      ADD COLUMN IF NOT EXISTS student_id text NULL,
      ADD COLUMN IF NOT EXISTS student_name_in_xero text NULL,
      ADD COLUMN IF NOT EXISTS email_subscription_status char(1) NOT NULL DEFAULT 'Y';
    CREATE TABLE IF NOT EXISTS bm_student_id_counter (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0)
    );
    INSERT INTO bm_student_id_counter (id, last_value)
    VALUES (true, 0) ON CONFLICT (id) DO NOTHING;
    UPDATE bm_student_id_counter SET last_value = GREATEST(
      last_value,
      COALESCE((SELECT MAX(substring(student_id FROM '^STD-([0-9]+)$')::bigint)
                FROM users WHERE student_id ~ '^STD-[0-9]+$'), 0)
    ) WHERE id = true;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_student_id
      ON users (student_id) WHERE student_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_company_site
      ON users (company_id, site_id);
    CREATE INDEX IF NOT EXISTS idx_users_email_subscription_status
      ON users (email_subscription_status);
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_users_site_id'
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT fk_users_site_id
          FOREIGN KEY (site_id)
          REFERENCES bm_sites(site_id)
          ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_users_email_subscription_status'
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT chk_users_email_subscription_status
          CHECK (email_subscription_status IN ('Y', 'N'));
      END IF;
    END $$;
  `);
  usersSiteSchemaReady = true;
}

// Centralized selection so all endpoints stay consistent
const USER_SELECT = `
  id,
  email,
  username,
  image,
  bio,
  name,
  address,
  cel,
  tel,
  contacts,
  type,
  status,
  student_id AS "studentId",
  student_name_in_xero AS "studentNameInXero",
  auth_session_version AS "authSessionVersion",
  email_subscription_status AS "emailSubscriptionStatus",
  site_id AS "siteId",
  (
    SELECT s.site_name
    FROM bm_sites s
    WHERE s.site_id = users.site_id
      AND s.company_id = users.company_id
    LIMIT 1
  ) AS "siteName",
  company_id AS "companyId",
  (
    SELECT c.company_name
    FROM bm_company c
    WHERE c.company_id = users.company_id
    LIMIT 1
  ) AS "companyName",
  (
    SELECT c.workspace_profile
    FROM bm_company c
    WHERE c.company_id = users.company_id
    LIMIT 1
  ) AS "workspaceProfile",
  createdat AS "createdAt",
  updatedat AS "updatedAt"
`;

export async function findByEmail(email) {
  await ensureUsersSiteSchema();
  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT},
       password
     FROM users
     WHERE email = $1
     LIMIT 1`,
    [email],
  );
  return rows[0];
}

export async function findByUsername(username) {
  await ensureUsersSiteSchema();
  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT},
       password
     FROM users
     WHERE username = $1
     LIMIT 1`,
    [username],
  );
  return rows[0];
}

export async function findById(id) {
  await ensureUsersSiteSchema();
  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT}
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  return rows[0];
}

export async function findAuthById(id) {
  await ensureUsersSiteSchema();
  const { rows } = await pool.query(
    `SELECT ${USER_SELECT},password FROM users WHERE id=$1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}

export async function createUser({
  email,
  username,
  passwordHash,
  companyId = null,
  image = "",
  bio = "",
  // New fields (optional) — safe defaults; will not break existing callers
  name = null,
  address = null,
  cel = null,
  tel = null,
  contacts = null,
  type = "employee",
  status = "active",
  siteId = null,
  studentNameInXero = null,
  actorUserId = null,
}) {
  await ensureUsersSiteSchema();
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  const studentId = type === 'student' ? await allocateStudentId(client) : null;
  const { rows } = await client.query(
    `INSERT INTO users (
        id, company_id, email, username, password, image, bio,
        name, address, cel, tel, contacts, type, status, site_id,
        student_id, student_name_in_xero
     )
     VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     )
     RETURNING
       ${USER_SELECT}`,
    [
      companyId,
      email,
      username,
      passwordHash,
      image,
      bio,
      name,
      address,
      cel,
      tel,
      contacts,
      type,
      status,
      siteId,
      studentId,
      studentNameInXero,
    ],
  );
  if (type === 'advisor' && status === 'active' && actorUserId) {
    await assignAdvisorRoleForUserType(client, {
      companyId, actorUserId, targetUserId: rows[0].id,
    });
  }
  await client.query('COMMIT');
  return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function allocateStudentId(client) {
  const { rows } = await client.query(
    `UPDATE bm_student_id_counter SET last_value = last_value + 1
     WHERE id = true RETURNING last_value`,
  );
  return `STD-${rows[0].last_value}`;
}

async function assignAdvisorRoleForUserType(client, { companyId, actorUserId, targetUserId }) {
  const { rows } = await client.query(
    `SELECT c.workspace_profile, rc.customer_id::text AS customer_id
       FROM bm_company c
       LEFT JOIN sophia_runtime.customers rc
         ON rc.external_company_id = c.company_id::text AND rc.status = 'active'
      WHERE c.company_id = $1::uuid`,
    [companyId],
  );
  if (rows.length !== 1) {
    const error = new Error('Student operations company requires one active runtime customer mapping');
    error.status = 409;
    throw error;
  }
  const scope = rows[0];
  if (scope?.workspace_profile !== 'student_operations') return;
  if (!scope.customer_id) {
    const error = new Error('Student operations company requires an active runtime customer mapping');
    error.status = 409;
    throw error;
  }
  const { rows: actorRows } = await client.query(
    `SELECT 1 FROM users WHERE id = $1::uuid AND company_id = $2::uuid
       AND status = 'active' LIMIT 1`,
    [actorUserId, companyId],
  );
  if (!actorRows.length) return;
  await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [scope.customer_id]);
  const { rows: chiefRows } = await client.query(
    `SELECT 1 FROM sophia_runtime.business_pack_entitlements
      WHERE customer_id = $1::uuid AND identity_user_id = $2
        AND pack_id = 'student-operations' AND status = 'active'
        AND role_key = 'chief_executive' LIMIT 1`,
    [scope.customer_id, actorUserId],
  );
  if (chiefRows.length && targetUserId === actorUserId) {
    const error = new Error('A Chief Executive cannot change their own role to Advisor');
    error.status = 409;
    throw error;
  }
  const { rows: existingRows } = await client.query(
    `SELECT role_key, status
       FROM sophia_runtime.business_pack_entitlements
      WHERE customer_id = $1::uuid AND identity_user_id = $2
        AND pack_id = 'student-operations'
      FOR UPDATE`,
    [scope.customer_id, targetUserId],
  );
  const existing = existingRows[0] ?? null;
  if (existing?.status === 'active' && existing.role_key === 'chief_executive' && !chiefRows.length) {
    const error = new Error('A Chief Executive role cannot be changed by an Advisor type selection');
    error.status = 409;
    throw error;
  }
  if (existing?.status === 'active' && existing.role_key === 'advisor') return;
  const assignment = await client.query(
    `INSERT INTO sophia_runtime.business_pack_entitlements (
       customer_id, identity_user_id, pack_id, status, role_key, authorization_revision
     ) VALUES ($1::uuid, $2, 'student-operations', 'active', 'advisor', 1)
     ON CONFLICT (customer_id, identity_user_id, pack_id) DO UPDATE
       SET status = 'active', role_key = 'advisor',
           authorization_revision = sophia_runtime.business_pack_entitlements.authorization_revision + 1,
           updated_at = now()
       WHERE sophia_runtime.business_pack_entitlements.role_key IS DISTINCT FROM 'chief_executive'
          OR $3::boolean
     RETURNING entitlement_id`,
    [scope.customer_id, targetUserId, chiefRows.length > 0],
  );
  if (!assignment.rows.length) return;
  await client.query(
    `INSERT INTO sophia_runtime.business_pack_access_audit_events (
       customer_id, identity_user_id, pack_id, event_type, outcome,
       correlation_id, metadata
     ) VALUES ($1::uuid, $2, 'student-operations',
       $3, 'allowed', gen_random_uuid()::text,
       $4::jsonb)`,
    [
      scope.customer_id,
      targetUserId,
      existing ? 'business_pack.entitlement.role_changed' : 'business_pack.entitlement.assigned',
      JSON.stringify({
        actorIdentityUserId: actorUserId,
        source: 'advisor_user_type',
        previousRoleKey: existing?.role_key ?? null,
      }),
    ],
  );
}

export async function updateUserById(
  id,
  {
    email,
    username,
    passwordHash,
    image,
    bio,
    // New fields (optional)
    name,
    address,
    cel,
    tel,
    contacts,
    companyId,
    type,
    status,
    emailSubscriptionStatus,
    siteId,
    studentNameInXero,
    actorUserId,
  },
) {
  await ensureUsersSiteSchema();
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  const sets = [];
  const params = [];
  let i = 1;

  if (email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(email);
  }
  if (username !== undefined) {
    sets.push(`username = $${i++}`);
    params.push(username);
  }
  if (passwordHash !== undefined) {
    sets.push(`password = $${i++}`);
    params.push(passwordHash);
  }
  if (image !== undefined) {
    sets.push(`image = $${i++}`);
    params.push(image);
  }
  if (bio !== undefined) {
    sets.push(`bio = $${i++}`);
    params.push(bio);
  }

  if (name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(name);
  }
  if (address !== undefined) {
    sets.push(`address = $${i++}`);
    params.push(address);
  }
  if (cel !== undefined) {
    sets.push(`cel = $${i++}`);
    params.push(cel);
  }
  if (tel !== undefined) {
    sets.push(`tel = $${i++}`);
    params.push(tel);
  }
  if (contacts !== undefined) {
    sets.push(`contacts = $${i++}`);
    params.push(contacts);
  }
  if (companyId !== undefined) {
    sets.push(`company_id = $${i++}`);
    params.push(companyId);
  }
  if (type !== undefined) {
    sets.push(`type = $${i++}`);
    params.push(type);
  }
  if (status !== undefined) {
    sets.push(`status = $${i++}`);
    params.push(status);
  }
  if (emailSubscriptionStatus !== undefined) {
    sets.push(`email_subscription_status = $${i++}`);
    params.push(emailSubscriptionStatus);
  }
  if (siteId !== undefined) {
    sets.push(`site_id = $${i++}`);
    params.push(siteId);
  }
  if (studentNameInXero !== undefined) {
    sets.push(`student_name_in_xero = $${i++}`);
    params.push(studentNameInXero);
  }

  if (type === 'student') {
    const { rows } = await client.query('SELECT type, student_id FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (rows[0] && !rows[0].student_id) {
      sets.push(`student_id = $${i++}`);
      params.push(await allocateStudentId(client));
    }
  }

  if (!sets.length) {
    await client.query('COMMIT');
    return findById(id);
  }

  sets.push(`updatedat = NOW()`);
  params.push(id);

  const { rows } = await client.query(
    `UPDATE users
     SET ${sets.join(", ")}
     WHERE id = $${i}
     RETURNING
       ${USER_SELECT}`,
    params,
  );
  if (type === 'advisor' && actorUserId && rows[0]?.status === 'active') {
    await assignAdvisorRoleForUserType(client, {
      companyId: rows[0].companyId, actorUserId, targetUserId: id,
    });
  }
  await client.query('COMMIT');
  return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function unsubscribeUserFromEmails(userId) {
  await ensureUsersSiteSchema();

  const { rows } = await pool.query(
    `UPDATE users
     SET email_subscription_status = 'N',
         updatedat = NOW()
     WHERE id = $1
     RETURNING ${USER_SELECT}`,
    [userId],
  );

  return rows[0] || null;
}

/** List users by company (company‑scoped) */
export async function listUsersByCompany({
  companyId,
  q,
  status,
  type,
  limit,
  offset,
}) {
  await ensureUsersSiteSchema();
  const filters = [];
  const params = [];
  let i = 1;

  if (companyId) {
    filters.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  if (q) {
    filters.push(
      `(username ILIKE $${i} OR email ILIKE $${i} OR name ILIKE $${i} OR EXISTS (
          SELECT 1
          FROM bm_company c
          WHERE c.company_id = users.company_id
            AND c.company_name ILIKE $${i}
        ) OR EXISTS (
          SELECT 1
          FROM bm_sites s
          WHERE s.site_id = users.site_id
            AND s.company_id = users.company_id
            AND s.site_name ILIKE $${i}
        ))`,
    );
    params.push(`%${q}%`);
    i++;
  }

  if (status) {
    filters.push(`status = $${i++}`);
    params.push(status);
  }

  if (type) {
    filters.push(`type = $${i++}`);
    params.push(type);
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT
       ${USER_SELECT},
       EXISTS (
         SELECT 1
         FROM (
           SELECT 1
           FROM bm_projects p
           WHERE p.company_id = users.company_id
             AND p.user_id = users.id
           UNION ALL
           SELECT 1
           FROM bm_documents d
           WHERE d.company_id = users.company_id
             AND d.user_id = users.id
           UNION ALL
           SELECT 1
           FROM bm_clients c
           WHERE c.company_id = users.company_id
             AND c.user_id = users.id
           UNION ALL
           SELECT 1
           FROM bm_suppliers s
           WHERE s.company_id = users.company_id
             AND s.user_id = users.id
           UNION ALL
           SELECT 1
           FROM bm_materials m
           WHERE m.company_id = users.company_id
             AND m.user_id = users.id
           UNION ALL
           SELECT 1
           FROM bm_labor l
           WHERE l.company_id = users.company_id
             AND l.user_id = users.id
           UNION ALL
           SELECT 1
           FROM bm_pricing_profiles pp
           WHERE pp.company_id = users.company_id
             AND pp.user_id = users.id
           UNION ALL
           SELECT 1
           FROM bm_project_types pt
           WHERE pt.company_id = users.company_id
             AND pt.user_id = users.id
           LIMIT 1
         ) linked
       ) AS "hasProcesses"
     FROM users
     ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY
       (COALESCE(status, 'active') = 'archived') ASC,
       LOWER(COALESCE(name, username, '')) ASC,
       createdat DESC
     LIMIT $${i++} OFFSET $${i}`,
    params,
  );
  return rows;
}

/** Count users by company (for pagination) */
export async function countUsersByCompany({ companyId, q, status, type }) {
  await ensureUsersSiteSchema();
  const filters = [];
  const params = [];
  let i = 1;

  if (companyId) {
    filters.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  if (q) {
    filters.push(
      `(username ILIKE $${i} OR email ILIKE $${i} OR name ILIKE $${i} OR EXISTS (
          SELECT 1
          FROM bm_company c
          WHERE c.company_id = users.company_id
            AND c.company_name ILIKE $${i}
        ) OR EXISTS (
          SELECT 1
          FROM bm_sites s
          WHERE s.site_id = users.site_id
            AND s.company_id = users.company_id
            AND s.site_name ILIKE $${i}
        ))`,
    );
    params.push(`%${q}%`);
    i++;
  }

  if (status) {
    filters.push(`status = $${i++}`);
    params.push(status);
  }

  if (type) {
    filters.push(`type = $${i++}`);
    params.push(type);
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM users
     ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}`,
    params,
  );
  return rows[0]?.total ?? 0;
}

export async function userHasRelatedProcesses(userId, companyId = null) {
  await ensureUsersSiteSchema();
  const params = [userId];
  let companyFilter = "";
  if (companyId) {
    params.push(companyId);
    companyFilter = "AND company_id = $2";
  }

  const { rowCount } = await pool.query(
    `
    SELECT 1
    FROM (
      SELECT 1 FROM bm_projects WHERE user_id = $1 ${companyFilter}
      UNION ALL
      SELECT 1 FROM bm_documents WHERE user_id = $1 ${companyFilter}
      UNION ALL
      SELECT 1 FROM bm_clients WHERE user_id = $1 ${companyFilter}
      UNION ALL
      SELECT 1 FROM bm_suppliers WHERE user_id = $1 ${companyFilter}
      UNION ALL
      SELECT 1 FROM bm_materials WHERE user_id = $1 ${companyFilter}
      UNION ALL
      SELECT 1 FROM bm_labor WHERE user_id = $1 ${companyFilter}
      UNION ALL
      SELECT 1 FROM bm_pricing_profiles WHERE user_id = $1 ${companyFilter}
      UNION ALL
      SELECT 1 FROM bm_project_types WHERE user_id = $1 ${companyFilter}
      LIMIT 1
    ) linked
    `,
    params,
  );

  return rowCount > 0;
}

export async function archiveUserById(id) {
  await ensureUsersSiteSchema();
  const { rowCount } = await pool.query(
    `UPDATE users
     SET status = 'archived', updatedat = NOW()
     WHERE id = $1`,
    [id],
  );
  return rowCount > 0;
}

export async function deleteUserById(id) {
  await ensureUsersSiteSchema();
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [
    id,
  ]);
  return rowCount > 0;
}
