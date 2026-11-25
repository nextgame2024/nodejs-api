import {readFile,writeFile} from 'node:fs/promises';
import {calculateCommission,selectCommissionRule} from '../src/business-packs/student-operations/student-commission-rules.js';
const root=new URL('../../../exports/astra-commission-review/',import.meta.url),plan=JSON.parse(await readFile(new URL('plan.json',root),'utf8'));
const results=[];
for(const row of plan.rows)for(const rule of row.rules){
 const id=`00000000-0000-4000-8000-${String(row.csvRow).padStart(12,'0')}`,r={...rule,rule_id:id,active:true} as any,c=rule.configuration;
 const facts={classification:rule.classification??'ELICOS',location:rule.location??'ON-SHORE',city:c.city??'Sydney',program:rule.program??undefined,enrolmentDate:c.effectiveFrom??c.effectiveTo??'2026-01-01',isBulk:false,trimester:1,selectedRuleId:id,eligibilityConfirmed:true};
 if(c.state==='blocked'){let rejected=false;try{selectCommissionRule([r],facts);}catch{rejected=true;}if(!rejected)throw new Error('Blocked row accepted');continue;}
 const calculation=calculateCommission(selectCommissionRule([r],facts),[{kind:'tuition',amountMinor:100000},{kind:'enrolment',amountMinor:20000},{kind:'materials',amountMinor:5000},{kind:'agency_discount',amountMinor:-1000}],facts);
 if(calculation.commissionMinor!==Math.round(100000*c.rateNumerator/c.rateDenominator))throw new Error(`Row ${row.csvRow} rate failed`);
 const noFees=calculateCommission(r,[{kind:'tuition',amountMinor:100000},{kind:'enrolment',amountMinor:0},{kind:'materials',amountMinor:0}],facts);
 if(noFees.components.some(c=>c.kind!=='commission'))throw new Error('Zero-fee benefit created');
 results.push({csvRow:row.csvRow,collegeId:row.collegeId,label:c.label,commissionMinor:calculation.commissionMinor,subtotalMinor:calculation.subtotalMinor,components:calculation.components});
}
await writeFile(new URL('calculation-verification.json',root),JSON.stringify(results,null,2));console.log({validated:results.length});
