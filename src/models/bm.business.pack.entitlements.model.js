import pool from "../config/db.js";

const PACK_CATALOG = Object.freeze({
  "open-for-australia": Object.freeze({
    workspaceProfile: "student_operations",
    roles: Object.freeze(["chief_executive", "operations", "advisor"]),
  }),
});

export function getPackDefinition(packId) {
  return PACK_CATALOG[packId] ?? null;
}

export async function getBusinessPackEntitlement({ companyId, targetUserId, packId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scope = await resolveTargetScope(client, companyId, targetUserId);
    if (!scope) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [
      scope.customer_id,
    ]);
    const { rows } = await client.query(
      `SELECT entitlement_id::text AS "entitlementId",
              pack_id AS "packId", role_key AS "roleKey",
              status, authorization_revision AS "authorizationRevision"
         FROM sophia_runtime.business_pack_entitlements
        WHERE customer_id = $1::uuid AND identity_user_id = $2 AND pack_id = $3
        LIMIT 1`,
      [scope.customer_id, targetUserId, packId],
    );
    await client.query("COMMIT");
    return rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveTargetScope(client, companyId, targetUserId, lock = false) {
  const { rows } = await client.query(
    `SELECT u.id::text AS user_id, u.status::text AS user_status,
            c.workspace_profile,
            rc.customer_id::text AS customer_id
       FROM users u
       JOIN bm_company c ON c.company_id = u.company_id
       LEFT JOIN sophia_runtime.customers rc
         ON rc.external_company_id = c.company_id::text AND rc.status = 'active'
      WHERE u.company_id = $1::uuid AND u.id = $2::uuid
      ORDER BY rc.customer_id
      ${lock ? "FOR UPDATE OF u, c" : ""}`,
    [companyId, targetUserId],
  );
  if (rows.length !== 1 || !rows[0].customer_id) return null;
  return rows[0];
}

export async function setBusinessPackEntitlement({
  companyId,
  targetUserId,
  packId,
  roleKey,
  actorUserId,
}) {
  const definition = getPackDefinition(packId);
  if (!definition) {
    const error = new Error("Unsupported business pack");
    error.status = 400;
    throw error;
  }
  if (roleKey !== null && !definition.roles.includes(roleKey)) {
    const error = new Error("Invalid business-pack role");
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await resolveTargetScope(client, companyId, targetUserId, true);
    if (!target) {
      const error = new Error("The selected user requires one active runtime customer mapping");
      error.status = 409;
      throw error;
    }
    if (target.workspace_profile !== definition.workspaceProfile) {
      const error = new Error("The selected company does not use this business-pack workspace");
      error.status = 409;
      throw error;
    }
    await client.query("SELECT set_config('sophia.tenant_id', $1, true)", [
      target.customer_id,
    ]);
    if (roleKey !== null && target.user_status !== "active") {
      const error = new Error("A business-pack role can only be assigned to an active user");
      error.status = 409;
      throw error;
    }

    const current = await client.query(
      `SELECT entitlement_id, status, role_key, authorization_revision
         FROM sophia_runtime.business_pack_entitlements
        WHERE customer_id = $1::uuid AND identity_user_id = $2 AND pack_id = $3
        FOR UPDATE`,
      [target.customer_id, targetUserId, packId],
    );
    const previous = current.rows[0] ?? null;
    let eventType = null;
    if (roleKey === null) {
      if (previous && previous.status !== "revoked") {
        await client.query(
          `UPDATE sophia_runtime.business_pack_entitlements
              SET status = 'revoked', role_key = NULL,
                  authorization_revision = authorization_revision + 1,
                  updated_at = now()
            WHERE entitlement_id = $1`,
          [previous.entitlement_id],
        );
        eventType = "business_pack.entitlement.revoked";
      }
    } else if (!(previous?.status === "active" && previous?.role_key === roleKey)) {
      await client.query(
        `INSERT INTO sophia_runtime.business_pack_entitlements (
           customer_id, identity_user_id, pack_id, status, role_key,
           authorization_revision
         ) VALUES ($1::uuid, $2, $3, 'active', $4, 1)
         ON CONFLICT (customer_id, identity_user_id, pack_id) DO UPDATE
           SET status = 'active', role_key = EXCLUDED.role_key,
               authorization_revision =
                 sophia_runtime.business_pack_entitlements.authorization_revision + 1,
               updated_at = now()`,
        [target.customer_id, targetUserId, packId, roleKey],
      );
      eventType = previous
        ? "business_pack.entitlement.role_changed"
        : "business_pack.entitlement.assigned";
    }

    if (eventType) {
      await client.query(
        `INSERT INTO sophia_runtime.business_pack_access_audit_events (
           customer_id, identity_user_id, pack_id, event_type,
           outcome, correlation_id, metadata
         ) VALUES ($1::uuid, $2, $3, $4, 'allowed', gen_random_uuid()::text, $5::jsonb)`,
        [
          target.customer_id,
          targetUserId,
          packId,
          eventType,
          JSON.stringify({
            actorIdentityUserId: actorUserId,
            previousRoleKey: previous?.role_key ?? null,
            roleKey,
            source: "business_manager_user_administration",
          }),
        ],
      );
    }
    const result = await client.query(
      `SELECT entitlement_id::text AS "entitlementId",
              pack_id AS "packId", role_key AS "roleKey", status,
              authorization_revision AS "authorizationRevision"
         FROM sophia_runtime.business_pack_entitlements
        WHERE customer_id = $1::uuid AND identity_user_id = $2 AND pack_id = $3
        LIMIT 1`,
      [target.customer_id, targetUserId, packId],
    );
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
