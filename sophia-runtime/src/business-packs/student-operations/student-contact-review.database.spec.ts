import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {StudentCollegeMatchingService} from './student-college-matching.service.js';
const url=process.env.LOCAL_SUPPLIERS_ADMIN_URL;
if(url&&!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('Local database only');
const suite=url?describe:describe.skip;
const name='review_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:url??'postgresql://localhost:1/postgres'});
const dbUrl=new URL(url??'postgresql://localhost:1/postgres');dbUrl.pathname='/'+name;
const pool=new Pool({connectionString:dbUrl.toString()});
const tenant=randomUUID(),other=randomUUID(),company=randomUUID(),otherCompany=randomUUID(),connection=randomUUID(),contact=randomUUID();
const actor=randomUUID(),failActor=randomUUID();
const principal={tenantId:tenant,role:'chief_executive',identityUserId:actor} as never;
async function transaction(t:string,fn:(db:any)=>Promise<any>){const db=await pool.connect();try{await db.query('BEGIN');await db.query('SET LOCAL ROLE sophia_runtime_app');await db.query("SELECT set_config('sophia.tenant_id',$1,true)",[t]);const value=await fn(db);await db.query('COMMIT');return value;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
const service=new StudentCollegeMatchingService({tenantTransaction:transaction,tenantReadTransaction:transaction} as never);
suite('Contact review atomic creation and tenant scope',()=>{
 beforeAll(async()=>{
  process.env.SOPHIA_RUNTIME_DATABASE_URL=dbUrl.toString();process.env.SOPHIA_RUNTIME_SCHEMA='sophia_runtime';
  await admin.query(`CREATE DATABASE ${name}`);
  await pool.query(`CREATE SCHEMA sophia_runtime; CREATE TYPE public.bm_record_status AS ENUM ('active','archived'); CREATE TABLE public.users(id uuid,company_id uuid,status text);
   CREATE TABLE sophia_runtime.customers(customer_id uuid PRIMARY KEY,external_company_id text,status text);
   CREATE TABLE public.bm_colleges(college_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,college_name text,trading_name text,acronym text,email text,tel text,notes text,status text CHECK(status IN ('active','archived')));
   CREATE TABLE public.bm_suppliers(supplier_id uuid PRIMARY KEY,user_id uuid NOT NULL,company_id uuid,supplier_name text,email text,tel text,notes text,status public.bm_record_status,supplier_type text);
   CREATE TABLE sophia_runtime.xero_connections(customer_id uuid,xero_connection_id uuid,status text);
   CREATE TABLE sophia_runtime.student_operations_xero_sync_configurations(customer_id uuid,xero_connection_id uuid,organisation_role text,enabled boolean);
   CREATE TABLE sophia_runtime.student_operations_xero_contacts(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid);
   CREATE TABLE sophia_runtime.student_college_xero_contact_links(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,college_id uuid,student_user_id uuid,classification text CHECK(classification IN ('college','other','unresolved')),revision integer DEFAULT 1,reviewed_by text,reviewed_at timestamptz DEFAULT now(),PRIMARY KEY(customer_id,xero_connection_id,xero_contact_id),CHECK((classification='college')=(college_id IS NOT NULL)));
   CREATE TABLE sophia_runtime.student_college_xero_mapping_events(customer_id uuid,xero_connection_id uuid,xero_contact_id uuid,actor_identity text,previous_value jsonb,confirmed_value jsonb);
   GRANT USAGE ON SCHEMA sophia_runtime TO sophia_runtime_app;
   GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA sophia_runtime TO sophia_runtime_app;`);
  await pool.query((await readFile(new URL('../../database/migrations/138_contact_review_suppliers.sql',import.meta.url),'utf8')).replaceAll('__SOPHIA_RUNTIME_SCHEMA__','sophia_runtime'));
  await pool.query(`CREATE TRIGGER validate_college_xero_mapping BEFORE INSERT OR UPDATE ON sophia_runtime.student_college_xero_contact_links FOR EACH ROW EXECUTE FUNCTION sophia_runtime.validate_college_xero_mapping()`);
  await pool.query("INSERT INTO public.users VALUES($1,$2,'active'),($3,$2,'active')",[actor,company,failActor]);
  await pool.query('INSERT INTO sophia_runtime.customers VALUES($1,$2,\'active\'),($3,$4,\'active\')',[tenant,company,other,otherCompany]);
  await pool.query("INSERT INTO sophia_runtime.xero_connections VALUES($1,$2,'active')",[tenant,connection]);
  await pool.query("INSERT INTO sophia_runtime.student_operations_xero_sync_configurations VALUES($1,$2,'operating',true)",[tenant,connection]);
  await pool.query('INSERT INTO sophia_runtime.student_operations_xero_contacts VALUES($1,$2,$3)',[tenant,connection,contact]);
 });
 afterAll(async()=>{await pool.end();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();});
 it.each(['college','supplier'])('creates and links a closed %s atomically',async kind=>{
  const revision=Number((await pool.query('SELECT revision FROM sophia_runtime.student_college_xero_contact_links')).rows[0]?.revision??0);
  const result=await service.resolve(principal,connection,contact,{classification:kind,collegeId:null,expectedRevision:revision,create:{name:'Closed '+kind,email:'test@example.com',closed:true}});
  expect(result.classification).toBe(kind);
  const directory=await transaction(tenant,db=>db.query('SELECT * FROM sophia_runtime.student_contact_review_directory WHERE kind=$1',[kind]));
  expect(directory.rows).toHaveLength(1);expect(directory.rows[0].status).toBe('archived');
  expect((await transaction(other,db=>db.query('SELECT * FROM sophia_runtime.student_contact_review_directory'))).rows).toEqual([]);
 });
 it('refuses stale retries before creating another record',async()=>{
  await expect(service.resolve(principal,connection,contact,{classification:'supplier',collegeId:null,expectedRevision:0,create:{name:'Should not exist',closed:false}})).rejects.toThrow('changed');
  expect((await pool.query("SELECT * FROM public.bm_suppliers WHERE supplier_name='Should not exist'")).rows).toEqual([]);
 });
 it('rejects cross-company supplier links and invalid creation fields',async()=>{
  const id=randomUUID();await pool.query("INSERT INTO bm_suppliers(supplier_id,user_id,company_id,supplier_name,status) VALUES($1,$1,$2,'Other','active')",[id,otherCompany]);
  await expect(service.resolve(principal,connection,contact,{classification:'supplier',collegeId:null,supplierId:id,expectedRevision:2})).rejects.toThrow('available supplier');
  await expect(service.resolve(principal,connection,contact,{classification:'college',collegeId:null,expectedRevision:2,create:{name:'',closed:false}})).rejects.toThrow('complete');
 });
 it('rolls back directory creation if the mapping audit fails',async()=>{
  await pool.query(`ALTER TABLE sophia_runtime.student_college_xero_mapping_events ADD CONSTRAINT fail_audit CHECK(actor_identity<>'${failActor}') NOT VALID`);
  await expect(service.resolve({tenantId:tenant,role:'chief_executive',identityUserId:failActor} as never,connection,contact,{classification:'supplier',collegeId:null,expectedRevision:2,create:{name:'Rollback record',closed:false}})).rejects.toThrow();
  expect((await pool.query("SELECT * FROM bm_suppliers WHERE supplier_name='Rollback record'")).rows).toEqual([]);
 });
 it('creates an active college and prevents duplicate names',async()=>{
  await service.resolve(principal,connection,contact,{classification:'college',collegeId:null,expectedRevision:2,create:{name:'Active college',closed:false}});
  await expect(service.resolve(principal,connection,contact,{classification:'college',collegeId:null,expectedRevision:3,create:{name:'Active college',closed:false}})).rejects.toThrow('already exists');
  expect((await pool.query("SELECT status FROM bm_colleges WHERE college_name='Active college'")).rows[0].status).toBe('active');
 });
});
