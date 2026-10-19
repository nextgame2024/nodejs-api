// Default read-only preview. --apply executes ONLY migration 079, once.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
const migrationId='079_imported_case_opened_dates.sql';
const schema=process.env.SOPHIA_RUNTIME_SCHEMA?.trim() || 'sophia_runtime';
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('Invalid schema');
const sql=(await readFile(new URL(`../sophia-runtime/src/database/migrations/${migrationId}`,import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__',schema);
const apply=process.argv.includes('--apply');
const db=new pg.Client({connectionString:process.env.OWNER_DATABASE_URL || process.env.SOPHIA_RUNTIME_DATABASE_URL || process.env.DATABASE_URL,connectionTimeoutMillis:20000});
try {
  await db.connect();
  await db.query(apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(apply) await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[migrationId]);
  const applied=await db.query('SELECT 1 FROM public.sophia_runtime_migrations WHERE id=$1',[migrationId]);
  if(applied.rowCount) {
    await db.query('ROLLBACK');
    console.log(JSON.stringify({mode:apply?'apply':'preview',result:'already_applied',migration: migrationId}));
  } else {
    await db.query('SET LOCAL ROLE sophia_runtime_app');
    const tenant=await db.query(`SELECT customer_id FROM ${schema}.customers WHERE external_company_id=$1 AND status='active'`,['80d5e42f-2de1-4792-86b5-54c7cdeb2660']);
    if(tenant.rowCount!==1)throw new Error('Expected exactly one active import company');
    await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[tenant.rows[0].customer_id]);
    const previewSql=sql.slice(sql.indexOf('WITH migrated AS ('),sql.indexOf(', changed AS ('))+' SELECT case_id,case_reference,previous_opened_on::text,opened_on::text FROM corrections ORDER BY case_reference';
    const before=(await db.query(previewSql)).rows;
    const totals=(await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE migration_key='existing_students_v1')::int AS imported
      FROM ${schema}.student_operations_cases WHERE customer_id=$1`,[tenant.rows[0].customer_id])).rows[0];
    let updated=0;
    if(apply){
      const result=await db.query(sql);const last=Array.isArray(result)?result.at(-1):result;
      updated=last.rowCount ?? 0;
      if(updated!==before.length)throw new Error('Concurrent date changes detected; correction rolled back');
      if((await db.query(previewSql)).rowCount!==0)throw new Error('Date verification failed; correction rolled back');
      await db.query('RESET ROLE');
      await db.query('INSERT INTO public.sophia_runtime_migrations(id) VALUES($1)',[migrationId]);
      await db.query('COMMIT');
    } else await db.query('ROLLBACK');
    const report={mode:apply?'apply':'preview',migration:migrationId,generatedAt:new Date().toISOString(),totalCases:totals.total,importedCases:totals.imported,corrections:before.length,updated,rows:before};
    const dir=new URL('../../exports/',import.meta.url);await mkdir(dir,{recursive:true});
    const output=new URL(`imported_case_dates_${apply?'applied':'preview'}_2026-10-19.json`,dir);
    await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({...report,rows:undefined,report:fileURLToPath(output)}));
  }
} catch(error){
  await db.query('ROLLBACK').catch(()=>{});
  console.error(error.code ? `Date correction failed (${error.code}).` : error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]'));
  process.exitCode=1;
} finally {await db.end();}
