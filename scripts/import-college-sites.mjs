// Preview by default. --apply requires an explicit Business Manager company UUID.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      if (cell) throw new Error(`Unexpected quote near row ${rows.length + 1}`);
      quoted = true;
    } else if (char === ',') {
      row.push(cell); cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const key = (value) => clean(value).toLocaleLowerCase('en-AU');

function phones(value) {
  const parts = clean(value).split(/\s*\/\s*/u).filter(Boolean);
  const mobile = parts.filter((part) => /^(?:\+61\s*4|04)/u.test(part));
  const phone = parts.filter((part) => !mobile.includes(part));
  return { phone: phone.join(' / ') || null, mobile: mobile.join(' / ') || null };
}

export function planImport(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/u, ''));
  const expected = ['Name', 'Email', 'Address', 'Phone', 'City', 'Category'];
  if (!rows.length || rows[0].length !== expected.length || rows[0].some((cell, i) => clean(cell) !== expected[i])) {
    throw new Error(`Expected CSV columns: ${expected.join(', ')}`);
  }
  const seen = new Set();
  const sites = [];
  const colleges = new Set();
  for (const [index, row] of rows.slice(1).entries()) {
    if (row.length !== expected.length) throw new Error(`CSV row ${index + 2} has ${row.length} columns`);
    const [name, email, address, rawPhone, city, category] = row.map(clean);
    if (!name || name.length > 200 || !city || city.length > 120 || address.length > 500 || category.length > 120) {
      throw new Error(`CSV row ${index + 2} has a missing or overlong name, city, address or category`);
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))) {
      throw new Error(`CSV row ${index + 2} has an invalid email`);
    }
    const { phone, mobile } = phones(rawPhone);
    if ((phone?.length ?? 0) > 80 || (mobile?.length ?? 0) > 80) throw new Error(`CSV row ${index + 2} has an overlong phone`);
    const siteKey = [key(name), key(city), key(address)].join('\u0000');
    if (seen.has(siteKey)) continue;
    seen.add(siteKey);
    colleges.add(key(name));
    sites.push({ name, email: email || null, address: address || null,
      phone, mobile, city, category: category || null });
  }
  return { sites, collegeCount: colleges.size, duplicateRows: rows.length - 1 - sites.length };
}

async function applyImport(plan, companyId) {
  const { default: pool } = await import('../src/config/db.js');
  const db = await pool.connect();
  const counts = { createdColleges: 0, createdSites: 0, skippedExistingSites: 0 };
  try {
    await db.query('BEGIN');
    const company = await db.query('SELECT company_id FROM bm_company WHERE company_id = $1 FOR UPDATE', [companyId]);
    if (company.rows.length !== 1) throw new Error('Business Manager company not found');
    const existing = await db.query('SELECT college_id, college_name FROM bm_colleges WHERE company_id = $1 FOR UPDATE', [companyId]);
    const colleges = new Map();
    for (const row of existing.rows) {
      const nameKey = key(row.college_name);
      if (colleges.has(nameKey)) throw new Error(`Ambiguous existing college name: ${row.college_name}`);
      colleges.set(nameKey, row.college_id);
    }
    const siteRows = await db.query(`SELECT college_id, city, address FROM bm_college_sites WHERE company_id = $1`, [companyId]);
    const existingSites = new Set(siteRows.rows.map((row) => [row.college_id, key(row.city), key(row.address)].join('\u0000')));
    const siteCounts = new Map();
    for (const row of siteRows.rows) siteCounts.set(row.college_id, (siteCounts.get(row.college_id) || 0) + 1);
    for (const site of plan.sites) {
      const nameKey = key(site.name);
      let collegeId = colleges.get(nameKey);
      if (!collegeId) {
        const created = await db.query(
          'INSERT INTO bm_colleges (company_id, college_name) VALUES ($1, $2) RETURNING college_id',
          [companyId, site.name],
        );
        collegeId = created.rows[0].college_id;
        colleges.set(nameKey, collegeId);
        counts.createdColleges += 1;
      }
      const siteKey = [collegeId, key(site.city), key(site.address)].join('\u0000');
      if (existingSites.has(siteKey)) { counts.skippedExistingSites += 1; continue; }
      const primary = !siteCounts.get(collegeId);
      await db.query(`INSERT INTO bm_college_sites
        (company_id, college_id, email, address, phone, mobile, city, category, is_primary)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [companyId, collegeId, site.email, site.address, site.phone, site.mobile,
        site.city, site.category, primary]);
      if (primary) await db.query(`UPDATE bm_colleges SET email = $3, address = $4,
        tel = $5, cel = $6, city = $7, category = $8, updatedat = now()
        WHERE company_id = $1 AND college_id = $2`,
      [companyId, collegeId, site.email, site.address, site.phone, site.mobile,
        site.city, site.category]);
      existingSites.add(siteKey);
      siteCounts.set(collegeId, (siteCounts.get(collegeId) || 0) + 1);
      counts.createdSites += 1;
    }
    await db.query('COMMIT');
    return counts;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((arg) => arg.startsWith('--file='))?.slice(7);
  const companyId = args.find((arg) => arg.startsWith('--company-id='))?.slice(13);
  const apply = args.includes('--apply');
  if (!file || args.some((arg) => !arg.startsWith('--file=') && !arg.startsWith('--company-id=') && arg !== '--apply')) {
    throw new Error('Usage: node scripts/import-college-sites.mjs --file=/path/directory.csv [--company-id=UUID --apply]');
  }
  if (apply && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(companyId ?? '')) {
    throw new Error('--apply requires a valid --company-id UUID');
  }
  const plan = planImport(await readFile(file, 'utf8'));
  const preview = { mode: apply ? 'apply' : 'preview', sourceRows: plan.sites.length + plan.duplicateRows,
    distinctColleges: plan.collegeCount, distinctSites: plan.sites.length, duplicateRows: plan.duplicateRows,
    primaryRule: 'First CSV site is primary only when a college has no existing sites' };
  if (!apply) { console.log(JSON.stringify(preview, null, 2)); return; }
  const result = await applyImport(plan, companyId);
  console.log(JSON.stringify({ ...preview, ...result }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
