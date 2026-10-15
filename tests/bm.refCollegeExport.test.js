import { describe, expect, test } from '@jest/globals';
import { normalizeRefCollege } from '../scripts/export-ref-college-csv.mjs';

describe('Ref / College CSV cleanup', () => {
  test('normalizes case and whitespace consistently', () => {
    expect(normalizeRefCollege('York business')).toBe('York Business');
    expect(normalizeRefCollege(' York  Business ')).toBe('York Business');
    expect(normalizeRefCollege('YORK BUSINESS')).toBe('York Business');
  });

  test('does not collapse uncertain names or reference variants', () => {
    expect(normalizeRefCollege('Greenwich')).not.toBe(normalizeRefCollege('Greenwich College'));
    expect(normalizeRefCollege('OSHC - VISA')).not.toBe(normalizeRefCollege('OSHC-VISA'));
  });

  test('drops blank values', () => {
    expect(normalizeRefCollege('  \u200B ')).toBe('');
    expect(normalizeRefCollege(null)).toBe('');
  });
});
