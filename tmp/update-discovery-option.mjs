import 'dotenv/config';
import pg from 'pg';
import {publishFormInTransaction} from '../src/services/leads/public-lead-forms.service.js';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});const db=await pool.connect();
const tenant='33ed40a6-7f2b-407c-aab2-de76b1cb45a8',id='e0939475-8a0a-4086-8828-7d6df6b85d10',actor='system:requested-form-option-update';
try{await db.query('BEGIN');await db.query('SET LOCAL ROLE sophia_runtime_app');await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[tenant]);
const row=(await db.query('SELECT blocks,version FROM sophia_runtime.lead_forms WHERE customer_id=$1 AND id=$2 FOR UPDATE',[tenant,id])).rows[0];
if(row.version!==6) throw Error('Form changed; review required');
let count=0;for(const b of row.blocks) b.options=b.options?.map(o=>{if(o!=="We've tried tools like ChatGPT, but only occasionally")return o;count++;return "We've tried tools like ChatGPT, Claude or Gemini, but occasionally.";})??[];
if(count!==1)throw Error('Expected exactly one matching option');
await db.query('UPDATE sophia_runtime.lead_forms SET blocks=$3::jsonb,version=version+1,updated_at=now() WHERE customer_id=$1 AND id=$2',[tenant,id,JSON.stringify(row.blocks)]);
await db.query('INSERT INTO sophia_runtime.lead_forms_audit(customer_id,actor_identity,entity_id,action) VALUES($1,$2,$3,$4)',[tenant,actor,id,'form_saved']);
const published=await publishFormInTransaction(db,tenant,actor,id,7);
if(!published.token.endsWith('.1e164a8d-0816-420c-8e36-16dcdbb6fec8'))throw Error('Public link changed');
await db.query('COMMIT');console.log('Updated draft and published option, version 7; public link preserved');
}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();await pool.end();}
process.exit(0);
