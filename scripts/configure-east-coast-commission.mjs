import 'dotenv/config';
import {writeFile} from 'node:fs/promises';
import pool from '../src/config/db.js';
import {validateCommission,saveCommission} from '../src/models/bm.collegeCommissions.model.js';
const company='80d5e42f-2de1-4792-86b5-54c7cdeb2660',college='9117cbb3-16d4-45c6-969b-61e4dc1de234';
try{
 const rows=(await pool.query('SELECT * FROM bm_college_commission_rules WHERE company_id=$1 AND college_id=$2 AND active',[company,college])).rows;
 if(rows.length!==1)throw new Error('Expected one active East Coast rule.');const r=rows[0];
 const configuration={...r.configuration,state:'ready',blockedReason:null,rateNumerator:3,rateDenominator:10,cashback:{mode:'enrolment_gross',amountMinor:0},benefits:[{source:'materials',percentageBasisPoints:10000,gstInclusive:true,itemCode:'MARKETING VET',saleName:'Marketing',advisorName:'O10 Open for Australia'}]};
 const value=validateCommission({classification:r.classification,location:r.location,program:r.program,commission_basis_points:3000,cashback_status:'specified',bonus_status:'not_applicable',cashback_description:null,bonus_description:null,application_conditions:null,cashback_calculation:null,bonus_amount:null,configuration,expected_updated_at:new Date(r.updatedat).toISOString()},true);
 if(process.argv.includes('--apply')){
  await writeFile('../exports/east-coast-rule-before-20261125.json',JSON.stringify(r,null,2),{flag:'wx',mode:0o600});
  const saved=await saveCommission(company,college,r.rule_id,value,false,'east-coast-workbook-and-INV-8406-review');console.log(JSON.stringify({ruleId:saved.ruleId,state:saved.configuration.state}));
 }else console.log(JSON.stringify({college,configuration}));
}finally{await pool.end();}
