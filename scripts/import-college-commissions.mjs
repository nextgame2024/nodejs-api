// Preview by default. Imports configuration only; never calculates or updates invoices.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './import-college-sites.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const headers = ['acronym','college','classification','location','program','commission','comission_calculation','cashback','cashback_calculation','bonus','aplication_conditions'];
const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/gu,' ').trim();
const conditionKey = r => JSON.stringify([r.collegeId,r.classification,r.location,r.program?.toLowerCase() ?? null]);
const payload = r => JSON.stringify([r.commissionBasisPoints,r.calculationDescription,r.cashbackStatus,r.cashbackDescription,r.cashbackCalculationDescription,r.bonusStatus,r.bonusDescription,r.applicationConditions]);
const benefitStatus = v => /^not recorded$/iu.test(v) || !v ? 'not_recorded' : /^(not applicable|no aplica)$/iu.test(v) ? 'not_applicable' : 'specified';

export function planCommissions(text) {
  const [head,...data] = parseCsv(text.replace(/^\uFEFF/u,''));
  if (JSON.stringify(head) !== JSON.stringify(headers) || !data.length) throw new Error('Unexpected or empty commission CSV');
  const rules = new Map(), colleges = new Map(), sourceRecords = [];
  let duplicateRows = 0;
  for (const [i,cells] of data.entries()) {
    const row = i+2;
    if (cells.length !== headers.length) throw new Error(`Row ${row}: invalid column count`);
    const original = Object.fromEntries(headers.map((h,j)=>[h,cells[j]]));
    sourceRecords.push(original);
    const v = Object.fromEntries(Object.entries(original).map(([k,val])=>[k,clean(val)]));
    const match = v.college.match(/^([0-9a-f-]{36}) - (.+)$/iu);
    if (!match || !uuid.test(match[1])) throw new Error(`Row ${row}: expected one college UUID and name`);
    const collegeId=match[1].toLowerCase(), acronym=v.acronym || null;
    if (v.acronym.length>80) throw new Error(`Row ${row}: acronym exceeds 80 characters`);
    const priorCollege=colleges.get(collegeId);
    if(priorCollege && (priorCollege.name!==match[2] || (acronym && priorCollege.acronym && acronym!==priorCollege.acronym))) throw new Error(`Row ${row}: inconsistent college name/acronym`);
    colleges.set(collegeId,{collegeId,name:match[2],acronym:acronym||priorCollege?.acronym||null});
    if(!['','ELICOS','VET','HE'].includes(v.classification) || !['','ON-SHORE','OFF-SHORE'].includes(v.location) || v.program.length>300) throw new Error(`Row ${row}: invalid rule condition`);
    const rate=v.commission.match(/^(\d{1,3})(?:\.(\d{1,2}))?%$/u);
    const bps=rate?Number(rate[1])*100+Number((rate[2]||'').padEnd(2,'0')):NaN;
    if(!Number.isInteger(bps)||bps>10000) throw new Error(`Row ${row}: invalid percentage`);
    if(v.comission_calculation!=='Tuition fee x commission (2 decimals)') throw new Error(`Row ${row}: unsupported calculation method`);
    const rule={collegeId,classification:v.classification||null,location:v.location||null,program:v.program||null,
      commissionBasisPoints:bps,calculationDescription:v.comission_calculation,
      cashbackStatus:benefitStatus(v.cashback),cashbackDescription:v.cashback,cashbackCalculationDescription:v.cashback_calculation,
      bonusStatus:benefitStatus(v.bonus),bonusDescription:v.bonus,applicationConditions:v.aplication_conditions,sourceRows:[row]};
    const key=conditionKey(rule), prior=rules.get(key);
    if(prior) {
      if(payload(prior)!==payload(rule)) throw new Error(`Rows ${prior.sourceRows[0]} and ${row}: conflicting rates or benefits for the same conditions`);
      prior.sourceRows.push(row); duplicateRows++;
    } else rules.set(key,rule);
  }
  const values=[...rules.values()];
  // General/specific overlaps are valid. Equally specific cross-condition overlaps are ambiguous.
  for(let i=0;i<values.length;i++) for(let j=i+1;j<values.length;j++) {
    const a=values[i],b=values[j], fields=['classification','location','program'];
    if(a.collegeId===b.collegeId && fields.filter(k=>a[k]).length===fields.filter(k=>b[k]).length
      && fields.every(k=>!a[k]||!b[k]||a[k].toLowerCase()===b[k].toLowerCase())) throw new Error(`Rows ${a.sourceRows[0]} and ${b.sourceRows[0]}: ambiguous equally specific rules`);
  }
  return {sha256:createHash('sha256').update(text).digest('hex'),sourceRecords,colleges:[...colleges.values()],rules:values,duplicateRows};
}

export async function importCommissions(db,plan,companyId,{apply=false,backupPath}={}) {
  if(!uuid.test(companyId??'')) throw new Error('Valid company UUID required');
  if(apply&&!backupPath) throw new Error('Apply requires a new backup path');
  await db.query(apply?'BEGIN':'BEGIN READ ONLY');
  try {
    if(apply) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-commissions:${companyId}`]);
    const ids=plan.colleges.map(c=>c.collegeId);
    const found=await db.query(`SELECT college_id,college_name,status,acronym FROM bm_colleges WHERE company_id=$1 AND college_id=ANY($2::uuid[])${apply?' FOR UPDATE':''}`,[companyId,ids]);
    for(const c of plan.colleges) {
      const row=found.rows.find(r=>r.college_id===c.collegeId);
      if(!row||row.status!=='active'||clean(row.college_name)!==c.name) throw new Error(`College validation failed: ${c.collegeId}`);
      if(c.acronym && row.acronym && c.acronym!==row.acronym) throw new Error(`Existing acronym differs for ${c.collegeId}`);
    }
    const existing=await db.query('SELECT * FROM bm_college_commission_rules WHERE company_id=$1 AND college_id=ANY($2::uuid[])',[companyId,ids]);
    const existingByKey=new Map(existing.rows.filter(r=>r.active).map(r=>[conditionKey({collegeId:r.college_id,classification:r.classification,location:r.location,program:r.program}),r]));
    let unchanged=0;
    for(const r of plan.rules) {
      const old=existingByKey.get(conditionKey(r));
      if(!old) continue;
      const oldPayload={commissionBasisPoints:old.commission_basis_points,calculationDescription:old.calculation_description,cashbackStatus:old.cashback_status,cashbackDescription:old.cashback_description,cashbackCalculationDescription:old.cashback_calculation_description,bonusStatus:old.bonus_status,bonusDescription:old.bonus_description,applicationConditions:old.application_conditions};
      if(payload(oldPayload)!==payload(r)||old.calculation_method!=='tuition_fee_percentage') throw new Error(`Existing rule differs for ${r.collegeId}; review before replacing`);
      unchanged++;
    }
    const summary={mode:apply?'applied':'preview',sourceRows:plan.sourceRecords.length,colleges:plan.colleges.length,rules:plan.rules.length,duplicatesConsolidated:plan.duplicateRows,newRules:plan.rules.length-unchanged,unchangedRules:unchanged,acronymsProvided:plan.colleges.filter(c=>c.acronym).length};
    if(apply) {
      const imports=await db.query('SELECT * FROM bm_college_commission_imports WHERE company_id=$1',[companyId]);
      await writeFile(backupPath,JSON.stringify({companyId,exportedAt:new Date().toISOString(),colleges:found.rows,rules:existing.rows,imports:imports.rows},null,2)+'\n',{flag:'wx',mode:0o600});
      const imported=await db.query(`INSERT INTO bm_college_commission_imports(company_id,source_sha256,source_records) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(company_id,source_sha256) DO UPDATE SET source_sha256=excluded.source_sha256 RETURNING import_id`,[companyId,plan.sha256,JSON.stringify(plan.sourceRecords)]);
      for(const c of plan.colleges) if(c.acronym) await db.query('UPDATE bm_colleges SET acronym=$3,updatedat=now() WHERE company_id=$1 AND college_id=$2 AND acronym IS DISTINCT FROM $3',[companyId,c.collegeId,c.acronym]);
      for(const r of plan.rules) {
        if(existingByKey.has(conditionKey(r))) continue;
        await db.query(`INSERT INTO bm_college_commission_rules(company_id,college_id,classification,location,program,commission_basis_points,
          calculation_description,cashback_status,cashback_description,cashback_calculation_description,bonus_status,bonus_description,application_conditions,import_id,source_rows)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[companyId,r.collegeId,r.classification,r.location,r.program,r.commissionBasisPoints,r.calculationDescription,r.cashbackStatus,r.cashbackDescription,r.cashbackCalculationDescription,r.bonusStatus,r.bonusDescription,r.applicationConditions,imported.rows[0].import_id,r.sourceRows]);
      }
    }
    await db.query('COMMIT'); return summary;
  } catch(error) {await db.query('ROLLBACK');throw error;}
}

async function main() {
  const args=process.argv.slice(2), opts={};
  for(const arg of args) {
    if(arg==='--apply') {opts.apply=true;continue;}
    const match=arg.match(/^--(input|company-id|backup)=(.+)$/u);
    if(!match) throw new Error('Usage: --input=CSV --company-id=UUID [--apply --backup=NEW_FILE]');
    opts[match[1]]=match[2];
  }
  if(!opts.input||!uuid.test(opts['company-id']??'')) throw new Error('Input CSV and company UUID required');
  const plan=planCommissions(await readFile(opts.input,'utf8'));
  const {default:pool}=await import('../src/config/db.js');
  const db=await pool.connect();
  try {console.log(JSON.stringify(await importCommissions(db,plan,opts['company-id'],{apply:opts.apply,backupPath:opts.backup}),null,2));}
  finally {db.release();await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});
