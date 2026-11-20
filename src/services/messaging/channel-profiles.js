import { publicRealtimeUrl } from "./realtime-invitation.js";
// Deployment-owned allowlist: customer/number bindings can never be supplied by
// a webhook or browser. Values are secret references, never browser credentials.
export function channelProfiles(env = process.env) {
  const raw = env.WHATSAPP_INBOUND_PROFILES;
  if (!raw) return [];
  let profiles;
  try {
    profiles = JSON.parse(raw);
  } catch {
    throw new Error("Invalid WhatsApp inbound configuration.");
  }
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const ids = new Set(),
    numbers = new Set();
  if (!Array.isArray(profiles) || profiles.length > 100)
    throw new Error("Invalid WhatsApp inbound configuration.");
  return profiles.map((p) => {
    if (
      !p ||
      !uuid.test(p.customerId) ||
      !/^[a-z0-9][a-z0-9_-]{7,79}$/.test(p.id) ||
      !/^\d{5,30}$/.test(p.phoneNumberId) ||
      !/^\d{5,30}$/.test(p.businessAccountId) ||
      typeof p.label !== "string" ||
      !p.label.trim() ||
      p.label.length > 100 ||
      !/^WHATSAPP_[A-Z0-9_]+$/.test(p.appSecretEnv) ||
      !/^WHATSAPP_[A-Z0-9_]+$/.test(p.verifyTokenEnv) ||
      ids.has(p.id) ||
      numbers.has(p.phoneNumberId)
    )
      throw new Error("Invalid WhatsApp inbound configuration.");
    ids.add(p.id);
    numbers.add(p.phoneNumberId);
    const appSecret = env[p.appSecretEnv],
      verifyToken = env[p.verifyTokenEnv];
    const ready =
      typeof appSecret === "string" &&
      appSecret.length >= 16 &&
      typeof verifyToken === "string" &&
      verifyToken.length >= 16;
    return {
      id: p.id,
      customerId: p.customerId,
      phoneNumberId: p.phoneNumberId,
      businessAccountId: p.businessAccountId,
      label: p.label.trim(),
      ready,
      sendingEnabled: p.sendingEnabled === true,
      graphVersion: /^v[0-9]{1,3}\.[0-9]{1,2}$/.test(p.graphVersion ?? "")
        ? p.graphVersion
        : null,
      accessToken: /^WHATSAPP_[A-Z0-9_]+$/.test(p.accessTokenEnv ?? "")
        ? env[p.accessTokenEnv]
        : null,
      reasoningAdapter:
        typeof p.reasoningAdapter === "string" ? p.reasoningAdapter : null,
      reasoningCredentialRef:
        typeof p.reasoningCredentialRef === "string" &&
        p.reasoningCredentialRef.length <= 160
          ? p.reasoningCredentialRef
          : null,
      realtimeUrl: publicRealtimeUrl(p.realtimeUrl),
      qualificationEnabled: p.qualificationEnabled === true,
      followUpEnabled: p.followUpEnabled === true,
      voiceEnabled: p.voiceEnabled === true,
      mediaKeyEnv: /^WHATSAPP_[A-Z0-9_]+$/.test(p.mediaKeyEnv ?? "")
        ? p.mediaKeyEnv
        : null,
      transcriptionAdapter:
        typeof p.transcriptionAdapter === "string"
          ? p.transcriptionAdapter
          : null,
      transcriptionCredentialRef:
        typeof p.transcriptionCredentialRef === "string"
          ? p.transcriptionCredentialRef
          : null,
      synthesisAdapter:
        typeof p.synthesisAdapter === "string" ? p.synthesisAdapter : null,
      synthesisCredentialRef:
        typeof p.synthesisCredentialRef === "string"
          ? p.synthesisCredentialRef
          : null,
      appSecret,
      verifyToken,
    };
  });
}

// Only the deployment-configured tenant/base profile may resolve a persisted
// coexistence credential. Caller-supplied tenant/phone mappings are never used.
export async function resolvedProfiles(db, tenant, env = process.env) {
  const profiles = channelProfiles(env);
  if (env.WHATSAPP_COEXISTENCE_ACTIVATION_ENABLED !== "true") return profiles;
  const customer = env.WHATSAPP_SIGNUP_CUSTOMER_ID;
  if (tenant && tenant !== customer) return profiles;
  const base = profiles.find(
    (p) =>
      p.customerId === customer && p.id === env.WHATSAPP_SIGNUP_BASE_PROFILE,
  );
  if (!base) return profiles;
  const ready = (
    await db.query(
      "SELECT to_regclass('sophia_runtime.whatsapp_connections') IS NOT NULL AS ready",
    )
  ).rows[0]?.ready;
  if (!ready) return profiles;
  const row = (
    await db.query(
      "SELECT * FROM sophia_runtime.whatsapp_connections WHERE customer_id=$1",
      [customer],
    )
  ).rows[0];
  if (!row) return profiles;
  const { unseal } = await import("./whatsapp-credentials.js");
  const token = row.encrypted_token
    ? unseal(
        row.encrypted_token,
        Buffer.from(env.WHATSAPP_SIGNUP_ENCRYPTION_KEY, "base64"),
        `${customer}:${row.profile_id}`,
      )
    : null;
  if (
    profiles.some(
      (p) => p.phoneNumberId === row.phone_number_id || p.id === row.profile_id,
    )
  )
    throw Error("Conflicting WhatsApp profile");
  return [
    ...profiles,
    {
      ...base,
      id: row.profile_id,
      label: "Sophia AI business number",
      phoneNumberId: row.phone_number_id,
      businessAccountId: row.business_account_id,
      accessToken: token,
      sendingEnabled: row.state === "ready",
      coexistence: true,
    },
  ];
}
export async function workerProfiles(env = process.env) {
  if (env.WHATSAPP_COEXISTENCE_ACTIVATION_ENABLED !== "true")
    return channelProfiles(env);
  const { default: pool } = await import("../../config/db.js");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE sophia_runtime_app");
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [
      env.WHATSAPP_SIGNUP_CUSTOMER_ID,
    ]);
    const p = await resolvedProfiles(db, env.WHATSAPP_SIGNUP_CUSTOMER_ID, env);
    await db.query("COMMIT");
    return p;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
