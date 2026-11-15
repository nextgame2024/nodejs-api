import 'dotenv/config';
import pg from 'pg';
import {listAppointments} from '../src/services/scheduling/lead-appointments.service.js';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const db=await pool.connect();
try {
 await db.query('BEGIN READ ONLY');
 await db.query('SET LOCAL ROLE sophia_runtime_app');
 const tenant='33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
 await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[tenant]);
 const form=(await db.query('SELECT id,version,blocks FROM sophia_runtime.lead_forms WHERE customer_id=$1 AND id=$2',[tenant,'e0939475-8a0a-4086-8828-7d6df6b85d10'])).rows[0];
 console.log(JSON.stringify({version:form.version,matching:form.blocks.filter(b=>b.options?.some(o=>o.includes('ChatGPT'))).map(b=>({id:b.id,options:b.options}))}));
 console.log(JSON.stringify((await db.query("SELECT a.starts_at,a.ends_at,a.status,a.customer_timezone,l.source FROM sophia_runtime.lead_appointments a JOIN sophia_runtime.assistant_leads l USING(customer_id,lead_id) WHERE a.customer_id=$1 AND a.starts_at>='2026-11-01' AND a.starts_at<'2026-12-01' ORDER BY a.starts_at",[tenant])).rows));
 const company=(await db.query('SELECT external_company_id FROM sophia_runtime.customers WHERE customer_id=$1',[tenant])).rows[0].external_company_id;
 const advisor=form.blocks.find(b=>b.kind==='calendar').calendar.advisorId;
 await db.query('ROLLBACK');
 const list=await listAppointments(advisor,company,{start:'2026-11-16',end:'2026-12-16',timezone:'Australia/Brisbane',page:1,limit:25});
 console.log(JSON.stringify({schedulingListTotal:list.total}));
}finally{db.release();await pool.end();}

process.exit(0);
