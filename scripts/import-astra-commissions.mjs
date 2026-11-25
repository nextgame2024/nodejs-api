import 'dotenv/config';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pool from '../src/config/db.js';
import {validateCommissionConfiguration} from '../src/utils/collegeCommissionConfiguration.js';
const company='80d5e42f-2de1-4792-86b5-54c7cdeb2660',root=new URL('../../exports/astra-commission-review/',import.meta.url);
const plan=JSON.parse(await readFile(new URL('plan.json',root),'utf8')),apply=process.argv.includes('--apply'),expected=process.argv.find(v=>v.startsWith('--expected-digest='))?.split('=')[1];
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const ids=[...new Set(plan.rows.filter(r=>r.rules.length).map(r=>r.collegeId))];
for(const row of plan.rows)for(const r of row.rules)validateCommissionConfiguration(r.configuration);
const db=await pool.connect();
try{
 await db.query(apply?'BEGIN':'BEGIN READ ONLY');
 if(apply){await db.query("SET LOCAL lock_timeout='5s'");await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-commissions:${company}`]);}
 const colleges=(await db.query(`SELECT college_id FROM bm_colleges WHERE company_id=$1 AND college_id=ANY($2::uuid[]) ORDER BY college_id${apply?' FOR UPDATE':''}`,[company,ids])).rows;
 const known=new Set(colleges.map(c=>c.college_id));
 for(const r of plan.rows)if(r.rules.length&&!known.has(r.collegeId)){r.status='Pending: Sophia college ID was not found in the configured company.';r.rules=[];}
 const targeted=plan.rows.filter(r=>r.rules.length),targetIds=[...new Set(targeted.map(r=>r.collegeId))];
 const existing=(await db.query(`SELECT * FROM bm_college_commission_rules WHERE company_id=$1 AND college_id=ANY($2::uuid[]) AND active ORDER BY rule_id${apply?' FOR UPDATE':''}`,[company,targetIds])).rows;
 const signature=r=>digest({college:r.college_id,classification:r.classification,location:r.location,program:r.program,configuration:r.configuration});
 const incoming=targeted.flatMap(row=>row.rules.map(rule=>({row,rule,sig:signature({college_id:row.collegeId,...rule})})));
 if(new Set(incoming.map(r=>r.sig)).size!==incoming.length)throw new Error('Duplicate incoming contracts require review.');
 const present=new Map(existing.map(r=>[signature(r),r])),wanted=new Set(incoming.map(r=>r.sig));
 const archive=existing.filter(r=>!wanted.has(signature(r))),insert=incoming.filter(r=>!present.has(r.sig));
 const previewDigest=digest({plan,existing});if(apply&&expected!==previewDigest)throw new Error('Source/configuration changed. Rerun preview.');
 const summary={mode:apply?'applied':'preview',rows:plan.rows.length,ready:plan.rows.filter(r=>r.status==='Ready').length,pending:plan.rows.filter(r=>r.status!=='Ready').length,archive:archive.length,insert:insert.length,previewDigest};
 if(apply){
  await writeFile(new URL(`backup-${Date.now()}.json`,root),JSON.stringify({company,existing,summary},null,2),{flag:'wx',mode:0o600});
  const migration='141_student_commission_rule_choices.sql';
  if(!(await db.query('SELECT 1 FROM public.sophia_runtime_migrations WHERE id=$1',[migration])).rowCount){await db.query(await readFile(new URL('../sophia-runtime/src/database/migrations/'+migration,import.meta.url),'utf8'));await db.query('INSERT INTO public.sophia_runtime_migrations(id) VALUES($1)',[migration]);}
  if(archive.length)await db.query("UPDATE bm_college_commission_rules SET active=false,updatedat=now(),changed_by='astra-workbook-review' WHERE company_id=$1 AND rule_id=ANY($2::uuid[])",[company,archive.map(r=>r.rule_id)]);
  for(const {row,rule} of insert){const c=rule.configuration;await db.query(`INSERT INTO bm_college_commission_rules(company_id,college_id,classification,location,program,commission_basis_points,calculation_description,cashback_status,bonus_status,configuration,changed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'astra-workbook-review')`,[company,row.collegeId,rule.classification,rule.location,rule.program,rule.commissionBasisPoints,`Workbook Source row ${row.workbookRow}; invoiced tuition before discounts`,c.cashback.mode==='none'?'not_applicable':'specified','not_applicable',JSON.stringify(c)]);}
  const after=(await db.query('SELECT * FROM bm_college_commission_rules WHERE company_id=$1 AND college_id=ANY($2::uuid[]) AND active',[company,targetIds])).rows;
  if(after.length!==incoming.length||after.some(r=>!wanted.has(signature(r))))throw new Error('Post-import verification failed.');
  await writeFile(new URL('verified-rules.json',root),JSON.stringify(after,null,2),{mode:0o600});
 }
 await db.query('COMMIT');await writeFile(new URL(apply?'applied.json':'preview.json',root),JSON.stringify(summary,null,2));
 const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
 const csv=[['acronym','college','COLEGIO','status'],...plan.rows.map(r=>[r.original.acronym,r.original.college,r.original.COLEGIO,r.status==='Ready'?(apply?'Done':'Ready — not yet applied'):r.status])].map(row=>row.map(quote).join(',')).join('\r\n')+'\r\n';
 await writeFile(new URL(apply?'colleges_comparisson_astra_status.csv':'preview-status.csv',root),'\ufeff'+csv);console.log(JSON.stringify(summary));
}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();await pool.end();}
