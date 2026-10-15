import { describe, expect, test } from '@jest/globals';
import { parseCsv, planImport } from '../scripts/import-college-sites.mjs';

describe('College site CSV import preview', () => {
  test('parses quoted addresses and keeps distinct sites within one city', () => {
    const csv = 'Name,Email,Address,Phone,City,Category\r\n'
      + 'ATI,info@ati.edu.au,"Level 1, 2 Main St",+61 3 9000 0000 / +61 412 333 444,Melbourne,College / VET\r\n'
      + 'ATI,info@ati.edu.au,"Level 2, 2 Main St",+61 3 9000 0000,Melbourne,College / VET\r\n'
      + 'ati,info@ati.edu.au,"Level 1, 2 Main St",+61 3 9000 0000,melbourne,College / VET\r\n';
    expect(parseCsv(csv)).toHaveLength(4);
    const plan = planImport(csv);
    expect(plan.collegeCount).toBe(1);
    expect(plan.sites).toHaveLength(2);
    expect(plan.duplicateRows).toBe(1);
    expect(plan.sites[0].phone).toBe('+61 3 9000 0000');
    expect(plan.sites[0].mobile).toBe('+61 412 333 444');
  });

  test('rejects malformed rows before opening a database connection', () => {
    expect(() => planImport('Name,Email,Address,Phone,City,Category\nATI,,,,,College\n'))
      .toThrow('missing or overlong');
  });
});
