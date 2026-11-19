import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
const url = process.env.LOCAL_WHATSAPP_SIGNUP_TEST_DATABASE_URL;
if (url && !['localhost','127.0.0.1'].includes(new URL(url).hostname)) throw Error('Disposable local PostgreSQL required.');
const pool = new Pool({ connectionString: url ?? 'postgresql://postgres@127.0.0.1:1/unused' });
jest.unstable_mockModule('../src/config/db.js', () => ({ default: pool }));
const { createWhatsAppSignupService } = await import('../src/services/messaging/whatsapp-signup.service.js');
const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const env = {
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true', WHATSAPP_META_APP_ID: '1107965912211301',
  WHATSAPP_SIGNUP_CONFIG_ID: '1141808901544273', WHATSAPP_GRAPH_VERSION: 'v26.0',
  WHATSAPP_SOPHIA_APP_SECRET: 'test-secret', WHATSAPP_SIGNUP_ENCRYPTION_KEY: Buffer.alloc(32,9).toString('base64'),
  WHATSAPP_SIGNUP_CUSTOMER_ID: tenant, WHATSAPP_SIGNUP_EXPECTED_PHONE: '+61400388532',
};
async function transact(_actor, company, work) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query('SET LOCAL ROLE sophia_runtime_app');
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)", [company]);
    const result = await work(db,company); await db.query('COMMIT'); return result;
  } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
const fetcher = jest.fn(async url => ({ ok: true, json: async () => url.pathname.endsWith('access_token') ? { access_token: 'synthetic-secret-token' } : { data: [{ id: '999999', display_phone_number: '+61 400 388 532', is_on_biz_app: true, platform_type: 'CLOUD_API' }] } }));
const api = createWhatsAppSignupService({ transact, fetcher, env });
(url ? describe : describe.skip)('Signup lifecycle with PostgreSQL RLS', () => {
  beforeAll(async () => {
    await pool.query(`CREATE ROLE sophia_runtime_app NOLOGIN NOBYPASSRLS; CREATE SCHEMA sophia_runtime;
      CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY);
      GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
      INSERT INTO sophia_runtime.customers VALUES('${tenant}'),('${other}');`);
    const migration = await readFile(new URL('../sophia-runtime/src/database/migrations/134_whatsapp_signup_authorization.sql', import.meta.url),'utf8');
    await pool.query(migration.replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
  });
  afterAll(async () => { await pool.query('DROP SCHEMA sophia_runtime CASCADE; DROP ROLE sophia_runtime_app'); await pool.end(); });
  test('stores encrypted authorization and verifies without changing a live channel', async () => {
    const attempt = await api.start('owner',tenant);
    await api.exchange('owner',tenant,{...attempt,code:'synthetic-code'});
    const stored = await transact('owner',tenant,db => db.query('SELECT encrypted_token FROM sophia_runtime.assistant_whatsapp_signup'));
    expect(JSON.stringify(stored.rows)).not.toContain('synthetic-secret-token');
    await expect(api.complete('owner',tenant,{...attempt,businessAccountId:'123456',event:'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'})).resolves.toMatchObject({state:'verified',activationPending:true});
    await expect(api.exchange('owner',tenant,{...attempt,code:'replay-code'})).rejects.toMatchObject({status:409});
  });
  test('hides rows and rejects cross-tenant writes with the application role', async () => {
    const read = await transact('other',other,db => db.query('SELECT * FROM sophia_runtime.assistant_whatsapp_signup'));
    expect(read.rows).toEqual([]);
    await expect(transact('other',other,db => db.query(`INSERT INTO sophia_runtime.assistant_whatsapp_signup(customer_id,signup_id,actor_identity,nonce_hash,state) VALUES($1,gen_random_uuid(),'other','hash','started')`,[tenant]))).rejects.toMatchObject({code:'42501'});
  });
  test('blocks expired attempts before provider access and erases expired tokens on status refresh', async () => {
    const attempt = await api.start('owner',tenant);
    await api.exchange('owner',tenant,{...attempt,code:'synthetic-code'});
    await pool.query("UPDATE sophia_runtime.assistant_whatsapp_signup SET expires_at=now()-interval '1 second'");
    fetcher.mockClear();
    await expect(api.complete('owner',tenant,{...attempt,businessAccountId:'123456',event:'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'})).rejects.toMatchObject({status:409});
    expect(fetcher).not.toHaveBeenCalled();
    await api.status('owner',tenant);
    const rows = await transact('owner',tenant,db => db.query('SELECT encrypted_token FROM sophia_runtime.assistant_whatsapp_signup'));
    expect(rows.rows.every(row => row.encrypted_token === null)).toBe(true);
  });
});
