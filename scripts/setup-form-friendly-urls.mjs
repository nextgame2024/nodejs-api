import 'dotenv/config.js';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { assignFormSlug, formUrl } from '../src/services/leads/lead-form-urls.js';
const file='142_lead_form_friendly_urls.sql';
const db=await pool.connect();
try {
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(74622133)');
  const applied=await db.query('SELECT 1 FROM public.sophia_runtime_migrations WHERE id=$1',[file]);
  if(!applied.rowCount){
    const sql=await readFile(new URL('../sophia-runtime/src/database/migrations/'+file,import.meta.url),'utf8');
    await db.query(sql.replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
    await db.query('INSERT INTO public.sophia_runtime_migrations(id) VALUES($1)',[file]);
  }
  // Migration owner enumerates IDs only; each assignment runs under tenant RLS.
  const rows=(await db.query(`SELECT f.customer_id,f.id,f.name,p.id AS publication_id FROM sophia_runtime.lead_forms f LEFT JOIN sophia_runtime.lead_form_publications p ON p.customer_id=f.customer_id AND p.form_id=f.id AND p.active WHERE f.friendly_slug IS NULL ORDER BY f.updated_at,f.id`)).rows;
  await db.query('SET LOCAL ROLE sophia_runtime_app');
  const result=[];
  for(const row of rows){
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[row.customer_id]);
    const slug=await assignFormSlug(db,row.customer_id,row.id);
    result.push({name:row.name,slug,url:formUrl(row.publication_id?row.customer_id+'.'+row.publication_id:null,slug,row.customer_id)});
  }
  if(process.argv.includes('--apply'))await db.query('COMMIT');else await db.query('ROLLBACK');
  console.log(JSON.stringify({applied:process.argv.includes('--apply'),forms:result},null,2));
}catch(error){await db.query('ROLLBACK');console.error('Friendly URL setup rolled back:',error.code||'setup_failed');process.exitCode=1;}
finally{db.release();await pool.end();}
