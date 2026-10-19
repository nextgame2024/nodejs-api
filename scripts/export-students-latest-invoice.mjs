import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(field); field = ''; }
    else if (!quoted && (c === '\r' || c === '\n')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function cell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('CSV path is required.');
  const original = parseCsv(await readFile(input, 'utf8'));
  const [headers, ...rows] = original;
  const emailColumn = headers.indexOf('email');
  const nameColumn = headers.indexOf('Nombre');
  if (emailColumn < 0 || nameColumn < 0 || rows.some(row => row.length !== headers.length)) throw new Error('Unexpected CSV columns.');
  if (headers.some(value => ['invoice_date', 'invoice_value', 'invoice_status'].includes(value))) throw new Error('Invoice columns already exist.');
  const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Database connection is not configured.');
  const db = new pg.Client({ connectionString, connectionTimeoutMillis: 20000 });
  const tenant = '33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
  let records;
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query('SET LOCAL ROLE sophia_runtime_app');
    await db.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenant]);
    const company = await db.query(`SELECT customer_id FROM sophia_runtime.customers
      WHERE customer_id=$1 AND external_company_id=$2 AND status='active'`, [tenant, '80d5e42f-2de1-4792-86b5-54c7cdeb2660']);
    if (company.rowCount !== 1) throw new Error('Export tenant could not be verified.');
    const result = await db.query(`
      SELECT roster.user_id, roster.legal_name, roster.email,
             latest.invoice_date::text, latest.total::text AS invoice_value,
             latest.invoice_status, latest.currency_code
        FROM sophia_runtime.student_operations_student_roster roster
        LEFT JOIN LATERAL (
          SELECT i.invoice_date, i.total, i.invoice_status, i.currency_code
            FROM sophia_runtime.student_operations_xero_invoices i
           WHERE i.customer_id=roster.customer_id
             AND i.invoice_type='ACCREC'
             AND i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')
             AND (i.student_id=roster.student_reference OR EXISTS (
               SELECT 1 FROM sophia_runtime.student_operations_case_invoice_links link
                WHERE link.customer_id=i.customer_id AND link.student_id=roster.profile_id
                  AND link.xero_connection_id=i.xero_connection_id AND link.xero_invoice_id=i.xero_invoice_id))
           ORDER BY i.invoice_date DESC NULLS LAST, i.xero_invoice_id DESC LIMIT 1
        ) latest ON true
       WHERE roster.customer_id=$1`, [tenant]);
    records = result.rows;
    await db.query('ROLLBACK');
  } finally {
    await db.end();
  }
  const byEmail = new Map();
  for (const record of records) {
    const email = normalize(record.email);
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) || []), record]);
  }
  const labels = { DRAFT: 'Draft', SUBMITTED: 'Awaiting approval', AUTHORISED: 'Awaiting payment', PAID: 'Paid' };
  let matched = 0, invoices = 0, ambiguous = 0;
  const currencies = new Set();
  const outputRows = rows.map(row => {
    let candidates = byEmail.get(normalize(row[emailColumn])) || [];
    if (candidates.length > 1) candidates = candidates.filter(record => normalize(record.legal_name) === normalize(row[nameColumn]));
    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguous++;
      return [...row, '', '', ''];
    }
    matched++;
    const record = candidates[0];
    if (record.invoice_value == null) return [...row, '', '', ''];
    invoices++;
    currencies.add(record.currency_code);
    return [...row, record.invoice_date || '', Number(record.invoice_value).toFixed(2), labels[record.invoice_status] || record.invoice_status];
  });
  const outputHeaders = [...headers, 'invoice_date', 'invoice_value', 'invoice_status'];
  const csv = [outputHeaders, ...outputRows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  const verification = parseCsv(csv);
  if (verification.length !== original.length || verification.some(row => row.length !== outputHeaders.length)) throw new Error('Export row validation failed.');
  for (let i = 0; i < original.length; i++) {
    if (original[i].some((value, column) => verification[i][column] !== value)) throw new Error('Original cell validation failed.');
  }
  const output = fileURLToPath(new URL('../../exports/students_client_export_with_latest_invoice_2026-10-19.csv', import.meta.url));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, csv, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ output, rows: rows.length, matchedStudents: matched, withInvoice: invoices,
    unmatchedStudents: rows.length - matched, ambiguousStudents: ambiguous, matchedWithoutInvoice: matched - invoices,
    currencies: [...currencies], originalCellsPreserved: true }));
}
main().catch(error => {
  console.error(error.code ? `Export failed (${error.code}).` : error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'));
  process.exitCode = 1;
});
