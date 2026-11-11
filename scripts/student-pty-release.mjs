// Restricted release helper: defaults to read-only preflight. It applies only
// the two reviewed PTY migrations, never unrelated pending migrations.
import 'dotenv/config';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const files=['127_student_pty_foundation.sql','128_student_commission_invoices.sql'];
const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(arg=>!['--check','--apply'].includes(arg)))throw new Error('Use --check or --apply.');
const schema=process.env.SOPHIA_RUNTIME_SCHEMA||'sophia_runtime';
if(!/^[a-z_][a-z0-9_]*$/i.test(schema))throw new Error('Invalid Runtime schema.');
const pool=new pg.Pool({connectionString:process.env.SOPHIA_RUNTIME_DATABASE_URL||process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000,
 ssl:process.env.SOPHIA_RUNTIME_DATABASE_SSL==='true'||process.env.DB_SSL==='true'?{rejectUnauthorized:true}:undefined});
try{
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('student-pty-release',0))");
  const ledger=(await db.query('SELECT id FROM public.sophia_runtime_migrations ORDER BY id')).rows.map(r=>r.id);
  const prerequisites=['080_student_sync_worker_pipeline.sql','100_student_xero_invoice_exports.sql'];
  if(prerequisites.some(id=>!ledger.includes(id)))throw new Error('Runtime migration prerequisites are missing.');
  const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='bm_college_commission_rules'")).rows.map(r=>r.column_name);
  if(!['rule_id','company_id','college_id','commission_basis_points','cashback_status','bonus_status','updatedat'].every(c=>columns.includes(c)))throw new Error('Business Manager commission rules are not ready.');
  const roles=(await db.query(`SELECT count(*)::int AS enabled FROM ${schema}.student_operations_xero_sync_configurations WHERE organisation_role='operating' AND enabled`)).rows[0];
  const pending=files.filter(file=>!ledger.includes(file));
  console.log(JSON.stringify({mode:apply?'apply':'check',lastApplied:ledger.at(-1),pending,enabledOperatingOrganisations:roles.enabled}));
  if(apply){
   if(roles.enabled&&pending.includes(files[0]))throw new Error('Deploy the updated shared worker before enabling PTY migration on an already active operating organisation.');
   for(const file of pending){
    const sql=await readFile(new URL(`../sophia-runtime/src/database/migrations/${file}`,import.meta.url),'utf8');
    await db.query(sql.replaceAll('__SOPHIA_RUNTIME_SCHEMA__',schema));
    await db.query('INSERT INTO public.sophia_runtime_migrations(id) VALUES($1)',[file]);
    console.log(`Applied ${file}`);
   }
   await db.query('COMMIT');
  }else await db.query('ROLLBACK');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}catch(error){console.error(JSON.stringify({error:typeof error?.code==='string'?error.code:'release_preflight_failed',message:typeof error?.code==='string'?'Release database check failed. No migration was committed.':error.message}));process.exitCode=1;}
finally{await pool.end();}
