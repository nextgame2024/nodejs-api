// Browser-assisted CRICOS contact enrichment.
// Safety defaults: one provider, sequential requests, no automatic retry, 30s timeout.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const providerPattern = /^\d{5}[A-Z0-9]$/u;
const coursePattern = /^[A-Z0-9]{6,10}$/u;
const defaultChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const maxHtmlBytes = 5 * 1024 * 1024;

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const decode = (value) => String(value ?? '')
  .replace(/&nbsp;|&#160;/giu, ' ')
  .replace(/&amp;/giu, '&')
  .replace(/&lt;/giu, '<')
  .replace(/&gt;/giu, '>')
  .replace(/&quot;|&#34;/giu, '"')
  .replace(/&#39;|&apos;/giu, "'")
  .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)));
const text = (html) => clean(decode(String(html ?? '').replace(/<br\s*\/?\s*>/giu, ' ').replace(/<[^>]+>/gu, ' ')));

function contactType(id) {
  const value = id.toLocaleLowerCase('en-AU');
  if (value.includes('principal')) return 'principal_executive_officer';
  if (value.includes('internationalstudentcontact')) return 'international_student_contact';
  return null;
}

function fieldName(id) {
  const value = id.toLocaleLowerCase('en-AU');
  if (value.endsWith('emailaddress')) return 'email';
  if (value.endsWith('phonenumber')) return 'phone';
  if (value.endsWith('faxnumber')) return 'fax';
  if (value.endsWith('title')) return 'title';
  if (value.endsWith('name')) return 'name';
  return null;
}

function elementValue(html, idSuffix) {
  const expression = new RegExp(`<(?:span|a)\\b[^>]*id=["'][^"']*${idSuffix}["'][^>]*>([\\s\\S]*?)<\\/(?:span|a)>`, 'iu');
  return text(html.match(expression)?.[1]);
}

export function parseCricosContacts(html, expectedProviderCode) {
  const providerCode = elementValue(html, 'lnkProviderCode').toUpperCase();
  if (!providerPattern.test(providerCode)) throw Object.assign(new Error('CRICOS provider code was not found'), { code: 'PARSE_PROVIDER' });
  if (expectedProviderCode && providerCode !== expectedProviderCode.toUpperCase()) {
    throw Object.assign(new Error('CRICOS provider did not match the requested page'), { code: 'PROVIDER_MISMATCH' });
  }
  const records = new Map();
  const expression = /<(span|a)\b([^>]*\bid=["']([^"']*contactDetail_[^"']*)["'][^>]*)>([\s\S]*?)<\/\1>/giu;
  for (const match of html.matchAll(expression)) {
    const type = contactType(match[3]);
    const field = fieldName(match[3]);
    if (!type || !field) continue;
    const record = records.get(type) ?? { contactType: type, name: null, title: null, email: null, phone: null, fax: null };
    record[field] = text(match[4]) || null;
    records.set(type, record);
  }
  const labels = {
    principal_executive_officer: 'Principal Executive Officer',
    international_student_contact: 'International Student Contact',
  };
  const contacts = [...records.values()].filter((record) => record.name || record.email || record.phone || record.fax).map((record) => {
    const normalized = { ...record, name: record.name || labels[record.contactType] };
    return {
      ...normalized,
      sourceKey: normalized.contactType,
      sourceHash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    };
  });
  return { providerCode, contacts };
}

export function cricosSourceUrl({ providerCode, courseCode }) {
  if (coursePattern.test(courseCode ?? '')) {
    return `https://cricos.education.gov.au/course/coursedetails.aspx?coursecode=${encodeURIComponent(courseCode.toLowerCase())}`;
  }
  if (!providerPattern.test(providerCode ?? '')) throw Object.assign(new Error('No CRICOS source page'), { code: 'HTML_MISSING' });
  const providerId = Number.parseInt(providerCode.slice(0, 5), 10);
  if (!Number.isInteger(providerId) || providerId < 1) throw Object.assign(new Error('No CRICOS source page'), { code: 'HTML_MISSING' });
  return `https://cricos.education.gov.au/Institution/InstitutionDetails.aspx?ProviderID=${providerId}`;
}

function browserError(code) {
  return Object.assign(new Error(code), { code });
}

export async function dumpCricosPage(url, {
  chromePath = process.env.CHROME_PATH || defaultChrome,
  timeoutMs = 30_000,
} = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), 'sophia-cricos-chrome-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-sync',
        `--user-data-dir=${profile}`, '--dump-dom', url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const output = [];
      let size = 0;
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxHtmlBytes) {
          child.kill('SIGTERM');
          finish(browserError('OUTPUT_LIMIT'));
          return;
        }
        output.push(chunk);
      });
      child.on('error', () => finish(browserError('BROWSER_START')));
      // `close` fires after stdout/stderr close; `exit` can race the final DOM chunks.
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) { finish(browserError('BROWSER_EXIT')); return; }
        const html = Buffer.concat(output).toString('utf8');
        const start = html.search(/<!doctype html|<html/iu);
        if (start < 0) { finish(browserError('HTML_MISSING')); return; }
        finish(null, html.slice(start));
      });
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(browserError('TIMEOUT'));
      }, timeoutMs);
    });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

export async function runSequential(candidates, handler, { delayMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const results = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      results.push({ providerCode: candidate.providerCode, ok: true, value: await handler(candidate) });
    } catch (error) {
      results.push({ providerCode: candidate.providerCode, ok: false, error });
    }
    if (index < candidates.length - 1) await sleep(delayMs);
  }
  return results;
}

function safeErrorCode(error) {
  const code = String(error?.code ?? '').toUpperCase();
  return ['OUTPUT_LIMIT', 'BROWSER_START', 'BROWSER_EXIT', 'HTML_MISSING', 'TIMEOUT',
    'PARSE_PROVIDER', 'PROVIDER_MISMATCH'].includes(code) ? code : 'UNEXPECTED';
}

async function candidates(db, companyId, { limit, providerCode, retryFailed }) {
  const args = [companyId];
  const filters = ['c.company_id = $1', 'c.cricos_provider_code IS NOT NULL'];
  if (providerCode) { args.push(providerCode); filters.push(`c.cricos_provider_code = $${args.length}`); }
  filters.push(retryFailed
    ? `(sync.cricos_provider_code IS NULL OR (sync.status = 'failed' AND sync.attempts < 2))`
    : 'sync.cricos_provider_code IS NULL');
  args.push(limit);
  const result = await db.query(`SELECT c.college_id AS "collegeId", c.cricos_provider_code AS "providerCode",
      coalesce(min(k.cricos_course_code) FILTER (WHERE NOT k.expired), min(k.cricos_course_code)) AS "courseCode"
    FROM bm_colleges c
    LEFT JOIN bm_college_courses k ON k.company_id = c.company_id AND k.college_id = c.college_id
    LEFT JOIN bm_cricos_contact_sync sync
      ON sync.company_id = c.company_id AND sync.cricos_provider_code = c.cricos_provider_code
    WHERE ${filters.join(' AND ')}
    GROUP BY c.college_id, sync.cricos_provider_code, sync.status, sync.attempts
    ORDER BY c.cricos_provider_code
    LIMIT $${args.length}`, args);
  return result.rows;
}

async function markAttempt(db, companyId, candidate, sourceUrl) {
  await db.query(`INSERT INTO bm_cricos_contact_sync
      (company_id,college_id,cricos_provider_code,sample_course_code,source_url,status,attempts,last_attempt_at,updatedat)
    VALUES($1,$2,$3,$4,$5,'processing',1,now(),now())
    ON CONFLICT(company_id,cricos_provider_code) DO UPDATE SET
      college_id=excluded.college_id,sample_course_code=excluded.sample_course_code,source_url=excluded.source_url,
      status='processing',attempts=bm_cricos_contact_sync.attempts+1,last_error_code=NULL,last_attempt_at=now(),updatedat=now()
    WHERE bm_cricos_contact_sync.status='failed' AND bm_cricos_contact_sync.attempts<2`,
  [companyId, candidate.collegeId, candidate.providerCode, candidate.courseCode, sourceUrl]);
}

async function persistContacts(db, companyId, candidate, sourceUrl, parsed) {
  await db.query('BEGIN');
  try {
    await db.query(`UPDATE bm_college_contacts SET source_active=false,updatedat=now()
      WHERE company_id=$1 AND college_id=$2 AND source='cricos'`, [companyId, candidate.collegeId]);
    for (const contact of parsed.contacts) {
      const phone = clean(contact.phone);
      const mobile = /^(?:\+?61\s*4|04)/u.test(phone) ? phone : null;
      const telephone = phone && !mobile ? phone : null;
      await db.query(`INSERT INTO bm_college_contacts
        (company_id,college_id,name,role_title,email,cel,tel,fax,source,source_key,contact_type,source_url,
         source_checked_at,source_hash,source_active,updatedat)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'cricos',$9,$10,$11,now(),$12,true,now())
        ON CONFLICT(company_id,college_id,source,source_key) WHERE source_key IS NOT NULL DO UPDATE SET
          name=excluded.name,role_title=excluded.role_title,email=excluded.email,cel=excluded.cel,tel=excluded.tel,
          fax=excluded.fax,contact_type=excluded.contact_type,source_url=excluded.source_url,
          source_checked_at=excluded.source_checked_at,source_hash=excluded.source_hash,source_active=true,updatedat=now()`,
      [companyId, candidate.collegeId, contact.name, contact.title, contact.email, mobile, telephone,
        contact.fax, contact.sourceKey, contact.contactType, sourceUrl, contact.sourceHash]);
    }
    await db.query(`UPDATE bm_cricos_contact_sync SET status=$3,contact_count=$4,last_error_code=NULL,
      completed_at=now(),updatedat=now() WHERE company_id=$1 AND cricos_provider_code=$2`,
    [companyId, candidate.providerCode, parsed.contacts.length ? 'succeeded' : 'no_contacts', parsed.contacts.length]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function markFailed(db, companyId, providerCode, error) {
  await db.query(`UPDATE bm_cricos_contact_sync SET status='failed',last_error_code=$3,updatedat=now()
    WHERE company_id=$1 AND cricos_provider_code=$2`, [companyId, providerCode, safeErrorCode(error)]);
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const companyId = value('company-id');
  const providerCode = value('provider-code')?.toUpperCase();
  const limit = Number.parseInt(value('limit') ?? '1', 10);
  const delayMs = Number.parseInt(value('delay-ms') ?? '15000', 10);
  const apply = args.includes('--apply');
  const retryFailed = args.includes('--retry-failed');
  const allowedFlags = new Set(['--apply', '--retry-failed']);
  if (!uuidPattern.test(companyId ?? '') || (providerCode && !providerPattern.test(providerCode))
    || !Number.isInteger(limit) || limit < 1 || limit > 10
    || !Number.isInteger(delayMs) || delayMs < 10_000
    || args.some((arg) => !arg.includes('=') && !allowedFlags.has(arg))) {
    throw new Error('Usage: node scripts/enrich-cricos-contacts.mjs --company-id=UUID [--provider-code=00000A] [--limit=1..10] [--delay-ms>=10000] [--apply] [--retry-failed]');
  }
  const { default: pool } = await import('../src/config/db.js');
  const db = await pool.connect();
  try {
    const work = await candidates(db, companyId, { limit, providerCode, retryFailed });
    const results = await runSequential(work, async (candidate) => {
      const sourceUrl = cricosSourceUrl(candidate);
      if (apply) await markAttempt(db, companyId, candidate, sourceUrl);
      try {
        const parsed = parseCricosContacts(await dumpCricosPage(sourceUrl), candidate.providerCode);
        if (apply) await persistContacts(db, companyId, candidate, sourceUrl, parsed);
        return { contactCount: parsed.contacts.length, contactTypes: parsed.contacts.map((item) => item.contactType) };
      } catch (error) {
        if (apply) await markFailed(db, companyId, candidate.providerCode, error);
        throw error;
      }
    }, { delayMs });
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview', requested: work.length,
      succeeded: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length,
      providers: results.map((item) => item.ok
        ? { providerCode: item.providerCode, ...item.value }
        : { providerCode: item.providerCode, errorCode: safeErrorCode(item.error) }) }, null, 2));
  } finally {
    db.release(); await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
