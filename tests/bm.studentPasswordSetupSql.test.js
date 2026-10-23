import { beforeAll, afterAll, describe, expect, test } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.LOCAL_PASSWORD_SETUP_TEST_DATABASE_URL;
if (url && !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Disposable local database required');
const suite = url ? describe : describe.skip;
suite('Student password setup owner migration and guarded backfill', () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const company = '22222222-2222-4222-8222-222222222222';
  let backfill;
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA sophia_runtime;
      CREATE TABLE sophia_runtime.customers(customer_id uuid,external_company_id text,status text);
      CREATE TABLE public.bm_company(company_id uuid,workspace_profile text);
      CREATE TABLE public.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid,type text,status text,student_id text,password text);
      INSERT INTO public.bm_company VALUES('${company}','student_operations');
      INSERT INTO sophia_runtime.customers VALUES('33ed40a6-7f2b-407c-aab2-de76b1cb45a8','${company}','active');
      INSERT INTO public.users(company_id,type,status,student_id,password)
        SELECT '${company}','student','active','STD-'||n,'preserved-hash-'||n FROM generate_series(1,1068) n;
      INSERT INTO public.users(company_id,type,status,student_id,password) VALUES
        ('${company}','employee','active',null,'staff-hash'),
        ('${company}','student','inactive','STD-inactive','inactive-hash'),
        ('33333333-3333-4333-8333-333333333333','student','active','STD-other','other-hash');`);
    await pool.query(await readFile(new URL('../sophia-runtime/src/database/migrations/088_user_password_setup_state.sql', import.meta.url), 'utf8'));
    backfill = await readFile(new URL('../scripts/sql/bm_student_password_setup_backfill.sql', import.meta.url), 'utf8');
  });
  afterAll(async () => { await pool.end(); });
  test('only flags the exact 1068 target students and preserves every existing password', async () => {
    expect((await pool.query('SELECT count(*)::int n FROM public.users WHERE must_change_password')).rows[0].n).toBe(0);
    await pool.query(backfill);
    expect((await pool.query('SELECT count(*)::int n FROM public.users WHERE must_change_password')).rows[0].n).toBe(1068);
    expect((await pool.query(`SELECT count(*)::int n FROM public.users WHERE student_id ~ '^STD-[0-9]+$'
      AND password='preserved-hash-'||substring(student_id FROM 5)`)).rows[0].n).toBe(1068);
    expect((await pool.query(`SELECT password,must_change_password FROM public.users WHERE student_id IS NULL
      OR student_id IN ('STD-inactive','STD-other') ORDER BY password`)).rows)
      .toEqual(['inactive-hash','other-hash','staff-hash'].map(password => ({password,must_change_password:false})));
    await pool.query(backfill);
    expect((await pool.query('SELECT count(*)::int n FROM public.users WHERE must_change_password')).rows[0].n).toBe(1068);
  });
  test('refuses a changed count without flagging any legacy account', async () => {
    await pool.query('UPDATE public.users SET must_change_password=false');
    await pool.query(`INSERT INTO public.users(company_id,type,status,student_id,password)
      VALUES($1,'student','active','STD-extra','new-hash')`, [company]);
    await expect(pool.query(backfill)).rejects.toThrow('Expected 1068 active students; found 1069');
    await pool.query('ROLLBACK');
    expect((await pool.query('SELECT student_id FROM public.users WHERE must_change_password')).rows).toEqual([{student_id:'STD-extra'}]);
  });
});
