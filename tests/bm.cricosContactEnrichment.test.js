import { describe, expect, jest, test } from '@jest/globals';
import { cricosSourceUrl, parseCricosContacts, runSequential } from '../scripts/enrich-cricos-contacts.mjs';

const html = `<!doctype html><html><body>
<a id="ctl00_cphDefaultPage_institutionDetail_lnkProviderCode">04100H</a>
<span id="ctl00_cphDefaultPage_contactDetail_litPrincipalExecutiveOfficerName">Joan Stone</span>
<span id="ctl00_cphDefaultPage_contactDetail_litPrincipalExcutiveOfficerTitle"></span>
<span id="ctl00_cphDefaultPage_contactDetail_litPrincipalExcutiveOfficerPhoneNumber">0412615728</span>
<span id="ctl00_cphDefaultPage_contactDetail_litPrincipalExcutiveOfficerFaxNumber"></span>
<a id="ctl00_cphDefaultPage_contactDetail_lnkPrincipalExecutiveOfficerEmailAddress" href="mailto:director@example.test">director@example.test</a>
</body></html>`;

describe('CRICOS contact enrichment', () => {
  test('parses source-labelled executive fields and validates the provider', () => {
    const parsed = parseCricosContacts(html, '04100H');
    expect(parsed.providerCode).toBe('04100H');
    expect(parsed.contacts).toHaveLength(1);
    expect(parsed.contacts[0]).toEqual(expect.objectContaining({
      contactType: 'principal_executive_officer', sourceKey: 'principal_executive_officer',
      name: 'Joan Stone', email: 'director@example.test', phone: '0412615728',
    }));
    expect(parsed.contacts[0].sourceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => parseCricosContacts(html, '00001K')).toThrow('did not match');
  });

  test('uses an official institution page when a provider has no course rows', () => {
    expect(cricosSourceUrl({ providerCode: '04100H', courseCode: '112441K' }))
      .toBe('https://cricos.education.gov.au/course/coursedetails.aspx?coursecode=112441k');
    expect(cricosSourceUrl({ providerCode: '04100H', courseCode: null }))
      .toBe('https://cricos.education.gov.au/Institution/InstitutionDetails.aspx?ProviderID=4100');
  });

  test('processes strictly sequentially, waits between providers and never retries a failure', async () => {
    let active = 0;
    let maximum = 0;
    const handler = jest.fn(async ({ providerCode }) => {
      active += 1; maximum = Math.max(maximum, active);
      active -= 1;
      if (providerCode === '00002J') throw Object.assign(new Error('failed'), { code: 'TIMEOUT' });
      return providerCode;
    });
    const sleep = jest.fn(async () => {});
    const results = await runSequential([
      { providerCode: '00001K' }, { providerCode: '00002J' }, { providerCode: '00003H' },
    ], handler, { delayMs: 10_000, sleep });
    expect(maximum).toBe(1);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(results.map((item) => item.ok)).toEqual([true, false, true]);
  });
});
