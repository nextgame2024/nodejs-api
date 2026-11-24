// Read-only planning by default. Applies only versioned college configuration, never invoices.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {parseCsv} from './import-college-sites.mjs';
import {validateCommissionConfiguration,commissionConditionsOverlap} from '../src/utils/collegeCommissionConfiguration.js';

export const columns=['acronym','college','site','type','city','program','afterDate','comissionRate','comissionFormula','cashbackFormula','bonus','conditions'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const compact=v=>v.toLowerCase().replace(/\s+/g,'');
const gcd=(a,b)=>b?gcd(b,a%b):a;
const ratio=decimal=>{const [w,f='']=decimal.split('.');const n=Number(w+f),d=10**f.length,g=gcd(n,d);return [n/g,d/g];};
// These are unresolved contractual questions, not college-specific execution code.
const pending={
 '05bd8846-c121-4e49-a949-65ad8f9527b6':'Confirm the 2026 cashback cutoff, the date it tests, and whether Enrolment + Materials is net or gross; provide Source V15.',
 'ee71a89e-3329-4055-a42f-4ff0e968dc60':'Confirm which transaction date the 01/11/2025 cutoff tests, instalment eligibility, and marketing amount: 90.90 NET differs from 100 gross / 1.10 = 90.91. The conditions still request confirmation of benefit stacking.',
 '0843b88b-9a3f-4f5e-807b-1d4ea820aada':'Confirm eligibility for the additional 75 gross marketing benefit and the separate Materials Support item/account/tracking mapping.',
 '96b9b843-0cb4-4a9d-af07-5565996cd45f':'Confirm first-to-ATI enrolment/payment evidence for the extra 5%, and the exact Materials versus CoE/Other Fee mapping. Historical support-line assignment is only inferred.',
 '31a4af08-039b-4c04-a44c-4030240188f4':'The formula says zero commission, but conditions still ask whether separate commission exists. Confirm the zero-commission contract and effective period against historical nonzero invoices.',
 '1f01f94a-df75-45d9-a6c6-2dff6788a0db':'Clarify whether ELICOS and Commercial Cookery are alternative qualifying programs; the CSV currently requires ELICOS AND Cookering. Define precedence over other VET and confirm exact gross-derived rates.',
 '9117cbb3-16d4-45c6-969b-61e4dc1de234':'Confirm the Materials benefit beneficiary and item/account/tracking mapping: CSV calls it Cashback Materials while historical INV-8406 uses MARKETING VET.',
 'b93b4080-fc98-4f37-baf5-de7acb40b021':'Define promotion eligibility date/evidence for the general and May–June Hospitality bonuses; confirm Bonus item account/tax and verified prior benefit consumption for each enrolment.',
 'b6e9a046-fd77-4701-bc4c-4e221aefbff5':'Contract/start evidence remains unverified. Confirm the 50% enrolment cashback, Bonus item account/tax, actual course start and prior one-time 500 gross bonus per enrolment.',
 '8d2e0de1-1167-45e9-8f6f-af96db7516b7':'Provide or approve the cashback email evidence referenced in conditions.',
 '6461164d-2061-4219-a9e9-b3ba8bbc6142':'Confirm Bonus item account/tax and verified actual start/enrolment identity/prior benefit history for the once-only 1000 gross bonus. Do not duplicate an old manually invoiced bonus.',
 '112c378f-974a-4ad7-a076-1a7b913f92cd':'Provide actual credited 10+2 promotional amounts and eligibility evidence, Bonus item mappings and prior once-per-enrolment history for both additive bonuses.',
 '43ba827e-1cf4-451a-ad84-0abc1122b628':'Identify the meanings and evidence for Data!B13 and Data!B14 before calculating the conditional 20 × B14 gross bonus.',
 'f52a9921-565b-40b1-b951-61251791c934':'Confirm whether fixed cashback and enrolment cashback stack, the beneficiary, eligibility/frequency and corresponding item mapping.',
 '5f565457-cbb2-48cf-8e6a-a8b7e3cd5527':'Confirm the item/account/tracking for fixed ELICOS Materials Marketing Support; imported history shows VET marketing whereas the updated formula limits this benefit to ELICOS.',
 '8bf2cfbb-3f07-46b6-aeb1-9f263ce80f45':'Confirm the Materials Support item/account/tracking for applicable course classifications. Imported examples establish MARKETING VET usage but do not establish the mapping for this unrestricted rule.',
};
function csvDate(value,row){if(!value)return null;const m=value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);const iso=m?`${m[3]}-${m[2]}-${m[1]}`:null;if(!iso||!Number.isFinite(Date.parse(iso))||new Date(iso).toISOString().slice(0,10)!==iso)throw new Error(`Row ${row}: invalid date`);return iso;}
export function planCommissionV2(text){
 const [header,...records]=parseCsv(text.replace(/^\uFEFF/,''));
 if(JSON.stringify(header)!==JSON.stringify(columns)||!records.length)throw new Error('Expected the final 12-column commission CSV.');
 const sourceRecords=[],rules=[],blocked=[];
 for(const [i,cells] of records.entries()){
  const row=i+2;if(cells.length!==columns.length)throw new Error(`Row ${row}: incorrect column count`);
  const original=Object.fromEntries(columns.map((c,j)=>[c,cells[j]]));sourceRecords.push(original);
  const r=Object.fromEntries(Object.entries(original).map(([k,v])=>[k,v.trim()]));
  const id=r.college.slice(0,36).toLowerCase();if(!uuid.test(id)||!r.college.startsWith(id+' - '))throw new Error(`Row ${row}: expected one college UUID and name`);
  if(!['','ELICOS','VET','HE'].includes(r.type)||!['','ON-SHORE','OFF-SHORE'].includes(r.site))throw new Error(`Row ${row}: unsupported selector`);
  if(!/^\d{1,3}(\.\d{1,2})?%$/.test(r.comissionRate))throw new Error(`Row ${row}: invalid rate`);
  const [whole,frac='']=r.comissionRate.slice(0,-1).split('.'),bp=Number(whole)*100+Number(frac.padEnd(2,'0'));if(bp>10000)throw new Error(`Row ${row}: invalid rate`);
  const cf=compact(r.comissionFormula),cb=compact(r.cashbackFormula),bonus=compact(r.bonus);
  const cfg={version:2,state:'ready',blockedReason:null,city:r.city||null,effectiveFrom:csvDate(r.afterDate,row),effectiveTo:null,dateBasis:r.afterDate?'enrolment_date':null,
   rateNumerator:bp,rateDenominator:10000,rateMethod:'fixed',laterRateNumerator:0,nonBulkOnly:false,cashback:{mode:'none',amountMinor:0}};
  const reasons=[];
  if(pending[id])reasons.push(pending[id]);
  if(r.city)reasons.push('Confirm that city means the course campus city and provide a verified campus source. Student residential city must not be substituted.');
  const straight=cf.match(/^(?:commission_net|commission)=round\((?:tuition_amount|tuition)\*(0\.\d+|1|0),2\)$/);
  const net=cf.match(/^(?:commission_net|commission)=round\((?:tuition_amount|tuition)\*\((0\.\d+)\/1\.10\),2\)$/);
  if(straight){[cfg.rateNumerator,cfg.rateDenominator]=ratio(straight[1]);if(Math.round(cfg.rateNumerator*10000/cfg.rateDenominator)!==bp)throw new Error(`Row ${row}: formula and rate disagree`);}
  else if(net){const [n,d]=ratio(net[1]);cfg.rateNumerator=n*10;cfg.rateDenominator=d*11;const g=gcd(cfg.rateNumerator,cfg.rateDenominator);cfg.rateNumerator/=g;cfg.rateDenominator/=g;}
  else if(cf==='commission_net=if(trimestre_number>=1,round(tuition_amount*if(trimestre_number<=2,0.20,if(trimestre_number<=4,0.15,0)),2),block)'){cfg.rateMethod='trimester';cfg.rateNumerator=20;cfg.rateDenominator=100;}
  else if(/^commission_net=round\(tuition_amount\*if\(course_month_number=1,0\.(20|15),0\.(15|10)\),2\)$/.test(cf)){const match=cf.match(/=1,0\.(\d+),0\.(\d+)/);cfg.rateMethod='first_month';cfg.rateNumerator=Number(match[1]);cfg.rateDenominator=100;cfg.laterRateNumerator=Number(match[2]);}
  else if(/^commission_net=if\(is_bulk=false,round\(tuition_amount\*0\.(20|15),2\),blocked\('q-unity'\)\)$/.test(cf)){cfg.nonBulkOnly=true;}
  else if(cf==='commission_net=if(tuition_amount>0,round(tuition_amount*0.20,2),0)'){}
  else if(id==='7ed05019-e59f-4aa4-977e-7d70dd96f9eb'&&cf.startsWith('commission_net=round(tuition_amount*if(enrolment_date>=date(2025,4,1),0.40,0.30),2);')&&cfg.effectiveFrom==='2025-04-01'&&bp===4000){}
  else if(!pending[id])reasons.push('The commission formula requires an explicitly reviewed typed calculation; it was not reduced to the displayed rate.');
  const zero=/^cashback(?:_net)?=0$/.test(cb);
  const enrolment=["cashback_net=if(enrolment_amount>0andnotalready_processed(trust_line_id,'cashback'),round(enrolment_amount/1.10,2),0)",'cashback_net=round(enrolment_amount/1.10,2)ifenrolment_amount>0andnot_already_processed_for_same_trust_lineelse0','cashback=round(enrolment/1.10,2)'].includes(cb);
  if(enrolment)cfg.cashback.mode='enrolment_gross';
  else if(cb==="cashback_net=if(enrolment_amount>0andnotalready_processed(trust_line_id,'cashback'),181.82,0)")cfg.cashback={mode:'fixed_net',amountMinor:18182};
  else if(!zero&&!pending[id])reasons.push('Cashback basis or eligibility is not fully specified for automatic calculation.');
  if(!['bonus_net=0;support_net=0','bonus_net=0'].includes(bonus)&&!pending[id])reasons.push('Additional benefit eligibility and item/account/tracking mapping need review; no component will be silently omitted.');
  if(cfg.effectiveFrom&&id!=='7ed05019-e59f-4aa4-977e-7d70dd96f9eb'&&!pending[id])reasons.push('Confirm the event date and inclusivity used by afterDate.');
  if(reasons.length){cfg.state='blocked';cfg.blockedReason=[...new Set(reasons)].join(' ');blocked.push({...original,reason:cfg.blockedReason});}
  rules.push({collegeId:id,classification:r.type||null,location:r.site||null,program:r.program||null,commissionBasisPoints:bp,configuration:validateCommissionConfiguration(cfg),sourceRows:[row],original});
 }
 // The user explicitly approved complementary enrolment-date intervals for Macallan.
 const mac=rules.filter(r=>r.collegeId==='7ed05019-e59f-4aa4-977e-7d70dd96f9eb');
 if(mac.length){if(mac.length!==2||!mac.some(r=>r.configuration.effectiveFrom==='2025-04-01'&&r.commissionBasisPoints===4000)||!mac.some(r=>!r.configuration.effectiveFrom&&r.commissionBasisPoints===3000))throw new Error('Review the approved Macallan date intervals.');const before=mac.find(r=>!r.configuration.effectiveFrom);before.configuration.effectiveTo='2025-03-31';before.configuration.dateBasis='enrolment_date';}
 for(let i=0;i<rules.length;i++)for(let j=i+1;j<rules.length;j++)if(rules[i].collegeId===rules[j].collegeId&&commissionConditionsOverlap(rules[i],rules[j]))throw new Error(`Rows ${rules[i].sourceRows} and ${rules[j].sourceRows}: overlapping commission rules`);
 return {sourceHash:digest(text),sourceRecords,rules,blocked,collegeIds:[...new Set(rules.map(r=>r.collegeId))]};
}
export function blockedCsv(plan){const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';return '\uFEFF'+[columns.concat('reason').map(quote).join(','),...plan.blocked.map(r=>columns.concat('reason').map(k=>quote(r[k])).join(','))].join('\r\n')+'\r\n';}
const payload=r=>({classification:r.classification,location:r.location,program:r.program,commission_basis_points:r.commissionBasisPoints,configuration:r.configuration,calculation_description:r.original.comissionFormula,cashback_description:r.original.cashbackFormula,bonus_description:r.original.bonus,application_conditions:r.original.conditions});
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>['classification','location','program','commission_basis_points','calculation_description','cashback_description','bonus_description','application_conditions'].every(k=>(a[k]??null)===(b[k]??null))&&canonical({...a.configuration,cashback:canonical(a.configuration?.cashback)})===canonical({...b.configuration,cashback:canonical(b.configuration?.cashback)});
export async function importCommissionV2(db,plan,companyId,{apply=false,backupPath,expectedDigest,actor='commission-import-v2'}={}){
 if(!uuid.test(companyId))throw new Error('Valid company ID required.');
 if(apply&&(!backupPath||!expectedDigest))throw new Error('Apply requires a new backup file and the reviewed preview digest.');
 await db.query(apply?'BEGIN':'BEGIN READ ONLY');
 try{
  if(apply)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-commissions:${companyId}`]);
  const colleges=(await db.query(`SELECT college_id,status FROM public.bm_colleges WHERE company_id=$1 AND college_id=ANY($2::uuid[]) ORDER BY college_id${apply?' FOR UPDATE':''}`,[companyId,plan.collegeIds])).rows;
  for(const id of plan.collegeIds)if(!colleges.some(c=>c.college_id===id&&c.status==='active'))throw new Error(`College missing, archived or outside company: ${id}`);
  const existing=(await db.query(`SELECT * FROM public.bm_college_commission_rules WHERE company_id=$1 AND college_id=ANY($2::uuid[]) ORDER BY rule_id${apply?' FOR UPDATE':''}`,[companyId,plan.collegeIds])).rows;
  const active=existing.filter(r=>r.active),retained=new Set(),insert=[];
  for(const r of plan.rules){const match=active.find(a=>!retained.has(a.rule_id)&&same(a,payload(r)));if(match)retained.add(match.rule_id);else insert.push(r);}
  const archive=active.filter(r=>!retained.has(r.rule_id));
  const outside=(await db.query('SELECT count(*)::integer AS count FROM public.bm_college_commission_rules WHERE company_id=$1 AND active AND NOT(college_id=ANY($2::uuid[]))',[companyId,plan.collegeIds])).rows[0].count;
  const previewDigest=digest({sourceHash:plan.sourceHash,companyId,prior:active.map(r=>({id:r.rule_id,updatedAt:r.updatedat,configuration:r.configuration})),desired:plan.rules.map(payload)});
  const summary={mode:apply?'applied':'preview',sourceRows:plan.sourceRecords.length,colleges:plan.collegeIds.length,readyRules:plan.rules.length-plan.blocked.length,blockedRules:plan.blocked.length,create:insert.length,archive:archive.length,retain:retained.size,unrelatedRulesRetained:outside,previewDigest,sourceHash:plan.sourceHash};
  if(apply){
   if(previewDigest!==expectedDigest)throw new Error('Configuration or source changed since preview; run the dry-run again.');
   const imports=(await db.query('SELECT * FROM public.bm_college_commission_imports WHERE company_id=$1',[companyId])).rows;
   const backup={version:2,companyId,collegeIds:plan.collegeIds,summary,existing,imports,exportedAt:new Date().toISOString()};
   await writeFile(backupPath,JSON.stringify(backup,null,2)+'\n',{flag:'wx',mode:0o600});
   if(insert.length||archive.length){
    const imported=(await db.query(`INSERT INTO public.bm_college_commission_imports(company_id,source_sha256,source_records) VALUES($1,$2,$3::jsonb) ON CONFLICT(company_id,source_sha256) DO UPDATE SET source_sha256=EXCLUDED.source_sha256 RETURNING import_id`,[companyId,plan.sourceHash,JSON.stringify(plan.sourceRecords)])).rows[0];
    if(archive.length)await db.query('UPDATE public.bm_college_commission_rules SET active=false,updatedat=now(),changed_by=$3 WHERE company_id=$1 AND rule_id=ANY($2::uuid[])',[companyId,archive.map(r=>r.rule_id),actor]);
    for(const r of insert)await db.query(`INSERT INTO public.bm_college_commission_rules(company_id,college_id,classification,location,program,commission_basis_points,calculation_description,cashback_status,cashback_description,bonus_status,bonus_description,application_conditions,configuration,import_id,source_rows,changed_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,[companyId,r.collegeId,r.classification,r.location,r.program,r.commissionBasisPoints,r.original.comissionFormula,r.configuration.cashback.mode==='none'?'not_applicable':'specified',r.original.cashbackFormula,['bonus_net=0;support_net=0','bonus_net=0'].includes(compact(r.original.bonus))?'not_applicable':'specified',r.original.bonus,r.original.conditions,JSON.stringify(r.configuration),imported.import_id,r.sourceRows,actor]);
   }
   backup.after=(await db.query('SELECT * FROM public.bm_college_commission_rules WHERE company_id=$1 AND college_id=ANY($2::uuid[]) ORDER BY rule_id',[companyId,plan.collegeIds])).rows;
   await writeFile(backupPath,JSON.stringify(backup,null,2)+'\n',{flag:'w',mode:0o600});
  }
  await db.query('COMMIT');return summary;
 }catch(error){await db.query('ROLLBACK');throw error;}
}
// Restores only configuration state, preserving newly imported rows as archived audit history.
export async function rollbackCommissionV2(db,backup,{apply=false,actor='commission-import-v2-rollback'}={}){
 if(backup.version!==2||!uuid.test(backup.companyId)||!Array.isArray(backup.collegeIds)||!backup.collegeIds.every(id=>uuid.test(id))||!Array.isArray(backup.after)||!Array.isArray(backup.existing))throw new Error('A completed v2 import backup is required.');
 const {companyId,collegeIds,existing,after}=backup;
 if([...existing,...after].some(r=>r.company_id!==companyId||!collegeIds.includes(r.college_id)))throw new Error('Backup contains out-of-scope records.');
 await db.query(apply?'BEGIN':'BEGIN READ ONLY');
 try{
  if(apply){await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`college-commissions:${companyId}`]);await db.query('SELECT college_id FROM public.bm_colleges WHERE company_id=$1 AND college_id=ANY($2::uuid[]) ORDER BY college_id FOR UPDATE',[companyId,collegeIds]);}
  const current=(await db.query(`SELECT * FROM public.bm_college_commission_rules WHERE company_id=$1 AND college_id=ANY($2::uuid[]) ORDER BY rule_id${apply?' FOR UPDATE':''}`,[companyId,collegeIds])).rows;
  if(digest(current)!==digest(after))throw new Error('Rules changed after import; review before rollback.');
  const previous=new Set(existing.filter(r=>r.active).map(r=>r.rule_id)),active=new Set(after.filter(r=>r.active).map(r=>r.rule_id));
  const archive=[...active].filter(id=>!previous.has(id)),restore=[...previous].filter(id=>!active.has(id));
  if(apply){
   if(archive.length)await db.query('UPDATE public.bm_college_commission_rules SET active=false,updatedat=now(),changed_by=$3 WHERE company_id=$1 AND rule_id=ANY($2::uuid[])',[companyId,archive,actor]);
   if(restore.length)await db.query('UPDATE public.bm_college_commission_rules SET active=true,updatedat=now(),changed_by=$3 WHERE company_id=$1 AND rule_id=ANY($2::uuid[])',[companyId,restore,actor]);
  }
  await db.query('COMMIT');return {mode:apply?'rolled_back':'rollback_preview',companyId,archive:archive.length,restore:restore.length};
 }catch(error){await db.query('ROLLBACK');throw error;}
}
async function main(){
 const opts={};for(const arg of process.argv.slice(2)){if(arg==='--apply')opts.apply=true;else{const m=arg.match(/^--(input|company-id|backup|expected-digest|blocked-output|rollback)=(.+)$/);if(!m)throw new Error('Unknown option');opts[m[1]]=m[2];}}
 if(opts.rollback){const backup=JSON.parse(await readFile(opts.rollback,'utf8'));const {default:pool}=await import('../src/config/db.js');const db=await pool.connect();try{console.log(JSON.stringify(await rollbackCommissionV2(db,backup,{apply:opts.apply}),null,2));}finally{db.release();await pool.end();}return;}
 const plan=planCommissionV2(await readFile(opts.input,'utf8'));
 if(opts['blocked-output'])await writeFile(opts['blocked-output'],blockedCsv(plan));
 if(!opts['company-id']){if(opts.apply)throw new Error('Company ID required for apply.');console.log(JSON.stringify({sourceRows:plan.sourceRecords.length,colleges:plan.collegeIds.length,readyRules:plan.rules.length-plan.blocked.length,blockedRules:plan.blocked.length,sourceHash:plan.sourceHash}));return;}
 const {default:pool}=await import('../src/config/db.js');const db=await pool.connect();
 try{console.log(JSON.stringify(await importCommissionV2(db,plan,opts['company-id'],{apply:opts.apply,backupPath:opts.backup,expectedDigest:opts['expected-digest']}),null,2));}finally{db.release();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
