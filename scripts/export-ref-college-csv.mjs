// Read-only export of the same Ref / College values shown in Payments and Control.
// Xero's invoice contact email belongs to the student, not to the college.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizeRefCollege(value) {
  if (typeof value !== 'string') return '';
  const compact = value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]+/gu, ' ').trim();
  if (!compact) return '';
  return compact.toLocaleLowerCase('en-AU').replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu,
    (_match, prefix, letter) => prefix + letter.toLocaleUpperCase('en-AU'));
}

function csvCell(value) {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function main() {
  const { default: pool } = await import('../src/config/db.js');
  const db = await pool.connect();
  let rawNames;
  try {
    await db.query('BEGIN READ ONLY');
    const customer = await db.query(
      'SELECT customer_id FROM sophia_runtime.customers WHERE name = $1 AND status = $2',
      ['OPEN 4 & CO PTY LTD', 'active'],
    );
    if (customer.rows.length !== 1) throw new Error('Open 4 & Co tenant was not uniquely identified.');
    const tenantId = customer.rows[0].customer_id;
    await db.query('SELECT set_config($1, $2, true)', ['sophia.tenant_id', tenantId]);
    const result = await db.query(
      `SELECT DISTINCT btrim(coalesce(i.invoice_reference, i.college_name)) AS value
         FROM sophia_runtime.student_operations_xero_invoices i
         JOIN sophia_runtime.student_operations_xero_sync_runs seen
           ON seen.customer_id = i.customer_id AND seen.sync_run_id = i.last_seen_sync_run_id
        WHERE i.customer_id = $1
          AND i.invoice_type IN ('ACCREC','ACCRECCREDIT','RECEIVE-PREPAYMENT','RECEIVE-OVERPAYMENT')
          AND i.invoice_status IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')
          AND seen.created_at >= COALESCE((
            SELECT max(full_run.created_at)
              FROM sophia_runtime.student_operations_xero_sync_runs full_run
             WHERE full_run.customer_id = i.customer_id
               AND full_run.xero_connection_id = i.xero_connection_id
               AND full_run.status = 'succeeded'
               AND full_run.mode IN ('initial','reconciliation')
          ), seen.created_at)
          AND nullif(btrim(coalesce(i.invoice_reference, i.college_name)), '') IS NOT NULL`,
      [tenantId],
    );
    rawNames = result.rows.map((row) => row.value);
    await db.query('ROLLBACK');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }

  // Only exact case/spacing variants collapse. Similar-but-different references
  // remain separate for human review; no fuzzy college-name assumptions are made.
  const unique = new Map();
  for (const raw of rawNames) {
    const normalized = normalizeRefCollege(raw);
    if (normalized) unique.set(normalized.toLocaleLowerCase('en-AU'), normalized);
  }
  const names = [...unique.values()].sort((a, b) => a.localeCompare(b, 'en-AU'));
  const csv = ['collegue,email,phone', ...names.map((name) => `${csvCell(name)},,`)].join('\n') + '\n';
  const output = fileURLToPath(new URL('../../exports/ref_college_open4co_2026-10-15.csv', import.meta.url));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, csv, { encoding: 'utf8', flag: 'w' });
  console.log(JSON.stringify({ output, distinctSourceValues: rawNames.length, exportedRows: names.length, emailRows: 0, phoneRows: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
