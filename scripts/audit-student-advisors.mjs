// Read-only comparison against the exact Students register projection.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { buildStudentRegisterCohortSql } from '../sophia-runtime/dist/business-packs/student-operations/student-operations-register.service.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
// Xero spells Muñoz as Munoz. Accent/case/spacing differences do not identify
// a different advisor; matches must still resolve to exactly one directory ID.
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').trim().replace(/\s+/gu, ' ').toLowerCase();
const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const tenant = '33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
const company = '80d5e42f-2de1-4792-86b5-54c7cdeb2660';

async function main() {
  const db = new pg.Client({ connectionString: process.env.SOPHIA_RUNTIME_DATABASE_URL || process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000 });
  let students, directory;
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query('SET LOCAL ROLE sophia_runtime_app');
    await db.query("SELECT set_config('sophia.tenant_id', $1, true)", [tenant]);
    const verified = await db.query('SELECT 1 FROM sophia_runtime.customers WHERE customer_id=$1 AND external_company_id=$2 AND status=$3', [tenant,company,'active']);
    if (verified.rowCount !== 1) throw new Error('Audit tenant could not be verified.');
    students = (await db.query(`${buildStudentRegisterCohortSql('sophia_runtime')}
      SELECT user_id,profile_id,student_reference,legal_name,case_id,case_reference,
             advisor_id,advisor_name,advisor_xero_name FROM cohort ORDER BY student_reference`,
    [tenant,null,null,null,null,null,null,null,null])).rows;
    directory = (await db.query(`SELECT advisor_id,code,name,xero_label,status
      FROM sophia_runtime.student_operations_advisor_directory WHERE customer_id=$1`,[tenant])).rows;
    await db.query('ROLLBACK');
  } finally { await db.end(); }

  const rows = students.map(student => {
    const source = normalize(student.advisor_xero_name);
    const matches = source ? directory.filter(advisor => advisor.status === 'active' &&
      [advisor.xero_label, `${advisor.code} ${advisor.name}`, advisor.name].some(label => normalize(label) === source)) : [];
    const expected = matches.length === 1 ? matches[0] : null;
    const resolution = !source ? 'missing_xero_advisor' : matches.length > 1 ? 'ambiguous_xero_advisor' :
      !expected ? 'unmapped_xero_advisor' : !student.profile_id ? 'missing_profile' :
      student.advisor_id === expected.advisor_id ? 'matched' : 'update_advisor';
    return { ...student, expected_advisor_id: expected?.advisor_id ?? null,
      expected_advisor_code: expected?.code ?? null, expected_advisor_name: expected?.name ?? null, resolution };
  });
  const summary = { comparedStudents: rows.length, directoryAdvisors: directory.length,
    outcomes: Object.fromEntries([...new Set(rows.map(row=>row.resolution))].map(key=>[key,rows.filter(row=>row.resolution===key).length])) };
  const outputDir = fileURLToPath(new URL('../../exports/', import.meta.url));
  await mkdir(outputDir,{recursive:true});
  const jsonPath = path.join(outputDir,'student_advisor_audit_2026-10-19.json');
  const flag = process.argv.includes('--refresh') ? 'w' : 'wx';
  await writeFile(jsonPath,JSON.stringify({ tenantId:tenant,companyId:company,auditedAt:new Date().toISOString(),summary,directory,rows },null,2)+'\n',{flag});
  const columns=['student_reference','legal_name','case_reference','advisor_name','advisor_xero_name','expected_advisor_name','resolution'];
  const csvPath=path.join(outputDir,'student_advisor_mismatches_2026-10-19.csv');
  await writeFile(csvPath,[columns,...rows.filter(row=>row.resolution!=='matched').map(row=>columns.map(key=>row[key]))]
    .map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n',{flag});
  console.log(JSON.stringify({ ...summary, report:csvPath, audit:jsonPath,
    mismatchGroups:Object.fromEntries([...new Set(rows.filter(row=>row.resolution==='update_advisor').map(row=>`${row.advisor_name ?? '(unassigned)'} -> ${row.expected_advisor_name}`))]
      .map(key=>[key,rows.filter(row=>row.resolution==='update_advisor' && `${row.advisor_name ?? '(unassigned)'} -> ${row.expected_advisor_name}`===key).length])) }));
}
main().catch(error=>{console.error(error.code ? `Audit failed (${error.code}).` : error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]'));process.exitCode=1;});
