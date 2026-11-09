// Decimal strings preserve two places without floating-point rounding. Blank is unknown, not zero.
export function commissionDecimal(value, label = 'Value') {
  if (value === undefined || value === null || value === '') return null;
  if (!['number', 'string'].includes(typeof value)) throw new Error(`${label} must be a non-negative number with up to two decimal places.`);
  const match = String(value).match(/^(\d{1,12})(?:\.(\d{1,2}))?$/u);
  if (!match) throw new Error(`${label} must be a non-negative number with up to two decimal places.`);
  return `${match[1].replace(/^0+(?=\d)/u, '')}.${(match[2] || '').padEnd(2, '0')}`;
}
