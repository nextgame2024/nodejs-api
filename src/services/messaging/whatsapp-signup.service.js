import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { transaction } from '../leads/assistant-settings.service.js';
import { fail } from '../leads/assistant-settings.contracts.js';

const table = 'sophia_runtime.assistant_whatsapp_signup';
const digits = value => typeof value === 'string' && /^\d{5,30}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
function configuration(env) {
  const key = Buffer.from(env.WHATSAPP_SIGNUP_ENCRYPTION_KEY ?? '', 'base64');
  if (env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED !== 'true' ||
      !digits(env.WHATSAPP_META_APP_ID) || !digits(env.WHATSAPP_SIGNUP_CONFIG_ID) ||
      !/^v\d{1,3}\.\d{1,2}$/.test(env.WHATSAPP_GRAPH_VERSION ?? '') ||
      !env.WHATSAPP_SOPHIA_APP_SECRET || key.length !== 32 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(env.WHATSAPP_SIGNUP_CUSTOMER_ID ?? '') ||
      !/^\+?[1-9]\d{6,19}$/.test(env.WHATSAPP_SIGNUP_EXPECTED_PHONE ?? '')) return null;
  return { appId: env.WHATSAPP_META_APP_ID, configId: env.WHATSAPP_SIGNUP_CONFIG_ID,
    graphVersion: env.WHATSAPP_GRAPH_VERSION, secret: env.WHATSAPP_SOPHIA_APP_SECRET,
    customerId: env.WHATSAPP_SIGNUP_CUSTOMER_ID, phone: env.WHATSAPP_SIGNUP_EXPECTED_PHONE.replace(/\D/g, ''), key };
}
function seal(token, key, context) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), body: body.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function unseal(value, key, context) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.body, 'base64')), decipher.final()]).toString('utf8');
}
const cleanInput = (input, keys) => input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(k => keys.includes(k));
function identity(input) {
  if (!/^[a-f0-9-]{36}$/i.test(input?.signupId ?? '') || !/^[a-f0-9]{64}$/.test(input?.nonce ?? '')) throw fail('Start WhatsApp authorization again.', 400);
  return [input.signupId, hash(input.nonce)];
}
export function createWhatsAppSignupService({ transact = transaction, fetcher = fetch, env = process.env } = {}) {
  async function scope(actor, company, work) {
    return transact(actor, company, async (db, tenant) => {
      const config = configuration(env);
      if (!config || config.customerId !== tenant) throw fail('WhatsApp onboarding is not available for this company yet.', 409);
      const ready = (await db.query("SELECT to_regclass('sophia_runtime.assistant_whatsapp_signup') IS NOT NULL AS ready")).rows[0]?.ready;
      if (!ready) throw fail('WhatsApp onboarding setup is pending. Contact your administrator.', 503);
      return work(db, tenant, config);
    });
  }
  async function graph(config, path, { token, parameters = {} } = {}) {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${path}`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    // Fixed Meta host; no browser-provided URLs. Never log requests/responses.
    const response = await fetcher(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw fail('Meta could not verify the connection. Start authorization again or check your Meta account permissions.', 502);
    const body = await response.json();
    if (!body || body.error) throw fail('Meta could not verify the connection. Start authorization again.', 502);
    return body;
  }
  async function markFailed(actor, company, id, nonceHash) {
    await scope(actor, company, async db => db.query(`UPDATE ${table} SET state='failed',encrypted_token=NULL,updated_at=now() WHERE signup_id=$1 AND actor_identity=$2 AND nonce_hash=$3 AND state<>'verified'`, [id, actor, nonceHash]));
  }
  return {
    async status(actor, company) {
      // Authorization is checked even when deployment setup is incomplete.
      return transact(actor, company, async (db, tenant) => {
        const config = configuration(env);
        if (!config || config.customerId !== tenant) return { available: false, connection: null };
        const ready = (await db.query("SELECT to_regclass('sophia_runtime.assistant_whatsapp_signup') IS NOT NULL AS ready")).rows[0]?.ready;
        if (!ready) return { available: false, connection: null };
        await db.query(`UPDATE ${table} SET encrypted_token=NULL,state=CASE WHEN state='verified' THEN state ELSE 'failed' END WHERE customer_id=$1 AND expires_at<=now() AND encrypted_token IS NOT NULL`, [tenant]);
        const row = (await db.query(`SELECT state,display_phone_number AS "phoneNumber" FROM ${table} WHERE customer_id=$1 AND actor_identity=$2 ORDER BY created_at DESC LIMIT 1`, [tenant, actor])).rows[0] ?? null;
        return { available: true, appId: config.appId, configId: config.configId, graphVersion: config.graphVersion, connection: row };
      });
    },
    async start(actor, company) {
      return scope(actor, company, async (db, tenant) => {
        // Keep credentials short-lived; each new attempt invalidates old attempts.
        await db.query(`DELETE FROM ${table} WHERE customer_id=$1 AND (expires_at<=now() OR actor_identity=$2)`, [tenant, actor]);
        const signupId = randomUUID(), nonce = randomBytes(32).toString('hex');
        await db.query(`INSERT INTO ${table}(customer_id,signup_id,actor_identity,nonce_hash,state) VALUES($1,$2,$3,$4,'started')`, [tenant, signupId, actor, hash(nonce)]);
        return { signupId, nonce };
      });
    },
    async exchange(actor, company, input) {
      if (!cleanInput(input, ['signupId','nonce','code']) || typeof input.code !== 'string' || input.code.length < 8 || input.code.length > 4096 || /[\x00-\x20]/.test(input.code)) throw fail('Invalid WhatsApp authorization response.', 400);
      const [id, nonceHash] = identity(input);
      const config = await scope(actor, company, async (db, tenant, c) => {
        const row = await db.query(`UPDATE ${table} SET state='exchanging',updated_at=now() WHERE customer_id=$1 AND signup_id=$2 AND actor_identity=$3 AND nonce_hash=$4 AND state='started' AND expires_at>now() RETURNING signup_id`, [tenant,id,actor,nonceHash]);
        if (!row.rowCount) throw fail('This authorization has expired or was already used. Start again.', 409);
        return { ...c, tenant };
      });
      try {
        const body = await graph(config, 'oauth/access_token', { parameters: { client_id: config.appId, client_secret: config.secret, code: input.code } });
        if (typeof body.access_token !== 'string' || body.access_token.length < 16 || body.access_token.length > 8192) throw fail('Meta did not return a usable authorization. Start again.', 502);
        const encrypted = seal(body.access_token, config.key, `${config.tenant}:${id}`);
        await scope(actor, company, async (db, tenant) => {
          const saved = await db.query(`UPDATE ${table} SET encrypted_token=$5::jsonb,state='authorized',updated_at=now() WHERE customer_id=$1 AND signup_id=$2 AND actor_identity=$3 AND nonce_hash=$4 AND state='exchanging' AND expires_at>now() RETURNING signup_id`, [tenant,id,actor,nonceHash,JSON.stringify(encrypted)]);
          if (!saved.rowCount) throw fail('Authorization expired. Start again.', 409);
        });
        return { state: 'authorized' };
      } catch (error) {
        await markFailed(actor, company, id, nonceHash);
        throw error.status ? error : fail('Meta authorization could not be completed. Start again.', 502);
      }
    },
    async complete(actor, company, input) {
      if (!cleanInput(input, ['signupId','nonce','businessAccountId','event']) || !digits(input.businessAccountId) || input.event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') throw fail('Complete the existing WhatsApp Business app connection flow.', 400);
      const [id, nonceHash] = identity(input);
      const task = await scope(actor, company, async (db, tenant, config) => {
        const row = (await db.query(`UPDATE ${table} SET state='verifying',updated_at=now() WHERE customer_id=$1 AND signup_id=$2 AND actor_identity=$3 AND nonce_hash=$4 AND state='authorized' AND expires_at>now() RETURNING encrypted_token`, [tenant,id,actor,nonceHash])).rows[0];
        if (!row) throw fail('Authorization expired or is not ready. Start again.', 409);
        return { config, tenant, encrypted: row.encrypted_token };
      });
      try {
        const token = unseal(task.encrypted, task.config.key, `${task.tenant}:${id}`);
        // Meta's account membership and expected phone are authoritative, never
        // browser phone IDs or a browser claim of company ownership.
        const phones = await graph(task.config, `${input.businessAccountId}/phone_numbers`, { token, parameters: { fields: 'id,display_phone_number,is_on_biz_app,platform_type', limit: '100' } });
        const phone = phones.data?.find(p => String(p.display_phone_number).replace(/\D/g, '') === task.config.phone);
        if (!phone || !digits(phone.id) || phone.is_on_biz_app !== true || phone.platform_type !== 'CLOUD_API') throw fail('Meta has not confirmed the expected number for both WhatsApp Business app and Cloud API.', 409);
        await scope(actor, company, async (db, tenant) => {
          const saved = await db.query(`UPDATE ${table} SET state='verified',business_account_id=$5,phone_number_id=$6,display_phone_number=$7,updated_at=now() WHERE customer_id=$1 AND signup_id=$2 AND actor_identity=$3 AND nonce_hash=$4 AND state='verifying' AND expires_at>now() RETURNING signup_id`, [tenant,id,actor,nonceHash,input.businessAccountId,phone.id,phone.display_phone_number]);
          if (!saved.rowCount) throw fail('Authorization expired. Start again.', 409);
        });
        return { state: 'verified', phoneNumber: phone.display_phone_number, activationPending: true };
      } catch (error) {
        await markFailed(actor, company, id, nonceHash);
        throw error.status ? error : fail('Meta account verification could not be completed. Start again.', 502);
      }
    },
  };
}
export const whatsappSignup = createWhatsAppSignupService();
