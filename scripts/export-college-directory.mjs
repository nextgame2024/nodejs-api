import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function exportCollegeDirectory(db, companyId) {
  if (!uuidPattern.test(companyId ?? '')) throw new Error('A valid company UUID is required');
  const company = await db.query(
    'SELECT company_id, company_name FROM bm_company WHERE company_id = $1',
    [companyId],
  );
  if (company.rows.length !== 1) throw new Error('Business Manager company not found');

  const [colleges, sites, contacts] = await Promise.all([
    db.query('SELECT * FROM bm_colleges WHERE company_id = $1 ORDER BY college_id', [companyId]),
    db.query('SELECT * FROM bm_college_sites WHERE company_id = $1 ORDER BY college_id, site_id', [companyId]),
    db.query('SELECT * FROM bm_college_contacts WHERE company_id = $1 ORDER BY college_id, id', [companyId]),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    company: company.rows[0],
    counts: {
      colleges: colleges.rows.length,
      sites: sites.rows.length,
      contacts: contacts.rows.length,
    },
    colleges: colleges.rows,
    sites: sites.rows,
    contacts: contacts.rows,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const companyId = args.find((arg) => arg.startsWith('--company-id='))?.slice(13);
  const output = args.find((arg) => arg.startsWith('--output='))?.slice(9);
  if (!uuidPattern.test(companyId ?? '') || !output || args.some((arg) =>
    !arg.startsWith('--company-id=') && !arg.startsWith('--output='))) {
    throw new Error('Usage: node scripts/export-college-directory.mjs --company-id=UUID --output=/path/export.json');
  }

  const { default: pool } = await import('../src/config/db.js');
  try {
    const payload = await exportCollegeDirectory(pool, companyId);
    const resolved = path.resolve(output);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ output: resolved, ...payload.counts }, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
