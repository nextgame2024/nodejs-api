import { test, expect, jest } from '@jest/globals';
jest.unstable_mockModule('../src/config/db.js', () => ({ default: {} }));
const { createWhatsAppSignupService } = await import('../src/services/messaging/whatsapp-signup.service.js');
const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const env = {
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'true', WHATSAPP_META_APP_ID: '1107965912211301',
  WHATSAPP_SIGNUP_CONFIG_ID: '1141808901544273', WHATSAPP_GRAPH_VERSION: 'v26.0',
  WHATSAPP_SOPHIA_APP_SECRET: 'test-app-secret', WHATSAPP_SIGNUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  WHATSAPP_SIGNUP_CUSTOMER_ID: tenant, WHATSAPP_SIGNUP_EXPECTED_PHONE: '+61400388532',
};
function fixture(options = {}) {
  let row;
  const db = { query: jest.fn(async (sql, args) => {
    if (sql.startsWith('SELECT to_regclass')) return { rows: [{ ready: true }] };
    if (sql.startsWith('DELETE')) { row = undefined; return { rowCount: 1 }; }
    if (sql.startsWith('INSERT')) { row = { signupId: args[1], actor: args[2], nonceHash: args[3], state: 'started' }; return { rowCount: 1 }; }
    if (sql.includes("SET state='exchanging'")) {
      if (row?.state !== 'started' || row.signupId !== args[1] || row.actor !== args[2] || row.nonceHash !== args[3]) return { rowCount: 0, rows: [] };
      row.state = 'exchanging'; return { rowCount: 1, rows: [{ signup_id: row.signupId }] };
    }
    if (sql.includes("SET encrypted_token=$5::jsonb,state='authorized'")) { row.state = 'authorized'; row.encrypted = JSON.parse(args[4]); return { rowCount: 1 }; }
    if (sql.includes("SET state='verifying'")) { row.state = 'verifying'; return { rows: [{ encrypted_token: row.encrypted }] }; }
    if (sql.includes("SET state='verified'")) { row.state = 'verified'; return { rowCount: 1 }; }
    if (sql.includes("SET state='failed'")) { row.state = 'failed'; row.encrypted = null; return { rowCount: 1 }; }
    throw Error('Unexpected test SQL');
  }) };
  const token = 'test-token-must-not-appear-in-result';
  const fetcher = jest.fn(async url => ({ ok: true, json: async () => url.pathname.endsWith('access_token') ? { access_token: token } : { data: [{ id: '999999', display_phone_number: '+61 400 388 532', is_on_biz_app: true, platform_type: 'CLOUD_API', ...options.phone }] } }));
  const transact = jest.fn(async (_actor, _company, work) => work(db, options.tenant ?? tenant));
  const api = createWhatsAppSignupService({ transact, fetcher, env: { ...env, ...options.env } });
  return { api, fetcher, db, token, transact, row: () => row };
}
test('gates signup by deployment configuration, server tenant and manager authorization before Meta calls', async () => {
  for (const options of [{ tenant: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { env: { WHATSAPP_EMBEDDED_SIGNUP_ENABLED: 'false' } }, { env: { WHATSAPP_SIGNUP_ENCRYPTION_KEY: 'bad' } }]) {
    const f = fixture(options);
    await expect(f.api.start('actor','company')).rejects.toMatchObject({ status: 409 });
    expect(f.fetcher).not.toHaveBeenCalled();
  }
  const transact = jest.fn(async () => { throw Object.assign(Error('Forbidden'),{status:403}); });
  const fetcher = jest.fn(); const api = createWhatsAppSignupService({ transact, fetcher, env });
  await expect(api.start('outsider','company')).rejects.toMatchObject({status:403});
  expect(fetcher).not.toHaveBeenCalled();
});
test('encrypts tokens, consumes the code once and verifies expected account membership without activating a channel', async () => {
  const f = fixture(), attempt = await f.api.start('actor','company');
  const result = await f.api.exchange('actor','company',{ ...attempt, code: 'exchange-code' });
  expect(result).toEqual({ state: 'authorized' });
  expect(JSON.stringify(f.row())).not.toContain(f.token);
  await expect(f.api.exchange('actor','company',{ ...attempt, code:'exchange-code' })).rejects.toMatchObject({status:409});
  const verified = await f.api.complete('actor','company',{ ...attempt, businessAccountId: '123456', event:'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' });
  expect(verified.activationPending).toBe(true);
  expect(JSON.stringify(verified)).not.toContain(f.token);
  expect(f.fetcher.mock.calls.map(([url]) => url.pathname)).toEqual(['/v26.0/oauth/access_token','/v26.0/123456/phone_numbers']);
  expect(f.db.query.mock.calls.every(([sql]) => !sql.includes('assistant_channels'))).toBe(true);
});
test('rejects another actor, forged nonce, browser tenant fields and non-coexistence completions', async () => {
  const f = fixture(), attempt = await f.api.start('actor','company');
  for (const [actor,input] of [['other',{...attempt,code:'exchange-code'}], ['actor',{...attempt,nonce:'0'.repeat(64),code:'exchange-code'}], ['actor',{...attempt,customerId:tenant,code:'exchange-code'}]]) {
    await expect(f.api.exchange(actor,'company',input)).rejects.toBeDefined();
  }
  await expect(f.api.complete('actor','company',{...attempt,businessAccountId:'123456',event:'FINISH'})).rejects.toMatchObject({status:400});
  expect(f.fetcher).not.toHaveBeenCalled();
});
test('fails closed for a different number or missing coexistence status and clears its encrypted credential', async () => {
  for (const phone of [{ display_phone_number: '+61 400 000 000' },{ is_on_biz_app: false },{ platform_type: 'OTHER' }]) {
    const f = fixture({phone}), attempt = await f.api.start('actor','company');
    await f.api.exchange('actor','company',{ ...attempt, code:'exchange-code' });
    await expect(f.api.complete('actor','company',{ ...attempt, businessAccountId:'123456',event:'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' })).rejects.toMatchObject({status:409});
    expect(f.row().encrypted).toBeNull();
  }
});
test('does not return provider payloads or token-bearing network errors', async () => {
  const f = fixture(), attempt = await f.api.start('actor','company');
  f.fetcher.mockRejectedValueOnce(Error('URL contains secret-token'));
  await expect(f.api.exchange('actor','company',{...attempt,code:'exchange-code'})).rejects.toMatchObject({status:502,message:'Meta authorization could not be completed. Start again.'});
  expect(f.row().encrypted).toBeNull();
});
