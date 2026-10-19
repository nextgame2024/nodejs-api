import {beforeAll,afterAll,describe,test,expect} from '@jest/globals';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

const url=process.env.LOCAL_CASE_DATES_TEST_DATABASE_URL;
if(url && (!['localhost','127.0.0.1'].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith('/case_dates_test')))
  throw new Error('A disposable local case_dates_test database is required');
const suite=url?describe:describe.skip;
const db=new pg.Client({connectionString:url});
const tenant='33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
const other='11111111-1111-4111-8111-111111111111';
const student='22222222-2222-4222-8222-222222222222';
const connection='33333333-3333-4333-8333-333333333333';
let sql;
suite('one-time imported case opening dates',()=>{
  beforeAll(async()=>{
    await db.connect();
    sql=(await readFile(new URL('../sophia-runtime/src/database/migrations/079_imported_case_opened_dates.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime');
    await db.query(`CREATE SCHEMA sophia_runtime;
      CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
      CREATE TABLE sophia_runtime.student_operations_cases(case_id text PRIMARY KEY,customer_id uuid,student_id uuid,case_reference text,
        opened_on date DEFAULT CURRENT_DATE,closed_on date,migration_key text,record_version int DEFAULT 1,updated_at timestamptz DEFAULT now(),
        CHECK(closed_on IS NULL OR closed_on>=opened_on));
      CREATE TABLE sophia_runtime.student_operations_xero_invoices(customer_id uuid,xero_connection_id uuid,xero_invoice_id text,student_id text,invoice_date date,invoice_type text,invoice_status text);
      CREATE TABLE sophia_runtime.student_operations_case_invoice_links(customer_id uuid,case_id text,student_id uuid,xero_connection_id uuid,xero_invoice_id text);
      CREATE TABLE sophia_runtime.student_operations_student_user_links(customer_id uuid,student_id uuid,student_reference text);
      CREATE TABLE sophia_runtime.student_operations_case_activity(customer_id uuid,case_id text,actor_identity_user_id text,event_type text,summary text,detail jsonb);
    `);
    await db.query("INSERT INTO sophia_runtime.customers VALUES($1,'80d5e42f-2de1-4792-86b5-54c7cdeb2660','active'),($2,'another-company','active')",[tenant,other]);
    await db.query("INSERT INTO sophia_runtime.student_operations_cases(case_id,case_reference,customer_id,student_id,opened_on,migration_key) VALUES('imported','CASE-1',$1,$3,'2026-10-16','existing_students_v1'),('native','CASE-2',$1,$3,'2026-10-19',NULL),('other','CASE-3',$2,$3,'2026-10-16','existing_students_v1'),('no-invoice','CASE-4',$1,$2,'2026-10-16','existing_students_v1')",[tenant,other,student]);
    await db.query("INSERT INTO sophia_runtime.student_operations_student_user_links VALUES($1,$2,'STD-1')",[tenant,student]);
    for(const [id,date,type,status,reference] of [
      ['latest','2029-10-01','ACCREC','DRAFT','STD-1'],
      ['oldest','2021-01-01','ACCREC','PAID','STD-1'],
      ['linked','2020-01-01','ACCREC','PAID',null],
      ['credit','2010-01-01','ACCRECCREDIT','PAID','STD-1'],
      ['void','1999-01-01','ACCREC','VOIDED','STD-1'],
      ['wrong-student','1998-01-01','ACCREC','PAID','STD-2'],
      ['no-date',null,'ACCREC','PAID','STD-1'],
    ]){
      await db.query('INSERT INTO sophia_runtime.student_operations_xero_invoices VALUES($1,$2,$3,$4,$5,$6,$7)',[tenant,connection,id,reference,date,type,status]);
      await db.query("INSERT INTO sophia_runtime.student_operations_case_invoice_links VALUES($1,'imported',$2,$3,$4)",[tenant,student,connection,id]);
    }
  });
  afterAll(async()=>{await db.end();});
  test('sets only imported cases to the oldest valid sales invoice date and audits the previous date',async()=>{
    await db.query(sql);
    const rows=(await db.query('SELECT case_id,opened_on::text,record_version FROM sophia_runtime.student_operations_cases ORDER BY case_id')).rows;
    expect(rows.find(r=>r.case_id==='imported')).toEqual({case_id:'imported',opened_on:'2020-01-01',record_version:2});
    expect(rows.find(r=>r.case_id==='native')).toEqual({case_id:'native',opened_on:'2026-10-19',record_version:1});
    expect(rows.find(r=>r.case_id==='other').opened_on).toBe('2026-10-16');
    expect(rows.find(r=>r.case_id==='no-invoice').opened_on).toBe('2026-10-16');
    const audit=(await db.query('SELECT detail FROM sophia_runtime.student_operations_case_activity')).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toEqual(expect.objectContaining({previousOpenedOn:'2026-10-16',openedOn:'2020-01-01'}));
  });
  test('rerunning produces no extra updates or audit entries; native defaults stay current',async()=>{
    await db.query(sql);
    expect((await db.query('SELECT count(*)::int n FROM sophia_runtime.student_operations_case_activity')).rows[0].n).toBe(1);
    await db.query("INSERT INTO sophia_runtime.student_operations_cases(case_id,customer_id,student_id) VALUES('new',$1,$2)",[tenant,student]);
    expect((await db.query("SELECT opened_on=CURRENT_DATE AS current FROM sophia_runtime.student_operations_cases WHERE case_id='new'")).rows[0].current).toBe(true);
  });
});
