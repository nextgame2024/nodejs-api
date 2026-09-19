import {afterAll,beforeAll,expect,it,jest} from '@jest/globals';
import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
const enabled=process.env.INSPECTION_SQL_TEST_DATABASE==='1';
const schema=`consultation_test_${crypto.randomBytes(8).toString('hex')}`;
const connectionUrl=enabled?new URL(process.env.DATABASE_URL):null;
if(connectionUrl)connectionUrl.hostname=connectionUrl.hostname.replace('-pooler.','.');
const options={connectionString:connectionUrl?.toString(),ssl:process.env.DB_SSL==='true'?{rejectUnauthorized:true}:undefined,connectionTimeoutMillis:10000};
const admin=enabled?new pg.Pool(options):null;
const pool=enabled?new pg.Pool({...options,options:`-c search_path=${schema},public`}):null;
jest.unstable_mockModule('../src/config/db.js',()=>({default:{query:(...args)=>pool.query(...args),connect:()=>pool.connect()}}));
const {ensureStudentConsultationSchema}=await import('../src/config/studentConsultationSchema.js');
const model=await import('../src/models/bm.studentConsultation.model.js');
const delivery=await import('../src/models/bm.studentConsultationEmail.model.js');
const company='90000000-0000-4000-8000-000000000001';
let slot,booking;
beforeAll(async()=>{if(!enabled)return;
 await admin.query(`CREATE SCHEMA ${schema}`);
 await pool.query('CREATE TABLE bm_company(company_id uuid PRIMARY KEY)');await pool.query('INSERT INTO bm_company VALUES ($1)',[company]);
 await ensureStudentConsultationSchema();await ensureStudentConsultationSchema();
 await pool.query("INSERT INTO bm_student_advisers(company_id,adviser_name,service_name,meeting_details,is_demo) VALUES ($1,'Demo','Demo','No meeting',true)",[company]);
 slot=(await model.listSlots(company))[0];
});
afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
const check=enabled?it:it.skip;
const details=()=>({slotId:slot.slotId,confirmedStartsAt:new Date(slot.startsAt).toISOString(),customerName:'Test Customer',customerEmail:'first@example.com',includeSummary:false,enquirySummary:'',sourceLinks:[],idempotencyKey:'first'});
check('replenishes demo calendar idempotently and isolates companies',async()=>{
 expect(slot.isDemo).toBe(true);expect(await model.listSlots(company)).toHaveLength(12);
 expect(await model.listSlots('90000000-0000-4000-8000-000000000002')).toHaveLength(0);
 const count=async()=>Number((await pool.query('SELECT count(*) FROM bm_student_consultation_slots')).rows[0].count);
 const before=await count();await model.refreshDemoSlots(company);expect(await count()).toBe(before);
});
check('rejects stale timestamps without creating a booking',async()=>{
 await expect(model.createBooking(company,{...details(),confirmedStartsAt:'2020-01-01T00:00:00Z'})).rejects.toThrow('no longer matches');
 expect(Number((await pool.query('SELECT count(*) FROM bm_student_consultation_bookings')).rows[0].count)).toBe(0);
});
check('serializes competing bookings, atomically queues one email and handles duplicate retries',async()=>{
 const results=await Promise.allSettled([model.createBooking(company,details()),model.createBooking(company,{...details(),customerEmail:'second@example.com',idempotencyKey:'second'})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 booking=results.find(r=>r.status==='fulfilled').value;
 const original={...details(),customerEmail:booking.customerEmail,idempotencyKey:booking.idempotencyKey};
 expect((await model.createBooking(company,original)).bookingId).toBe(booking.bookingId);
 await expect(model.createBooking(company,{...original,customerName:'Changed Name'})).rejects.toThrow('different details');
 expect(Number((await pool.query('SELECT count(*) FROM bm_student_consultation_deliveries')).rows[0].count)).toBe(1);
 expect((await model.listSlots(company)).some(s=>s.slotId===slot.slotId)).toBe(false);
});
check('claims a queue item once, protects its recipient, and records retry/logged accurately',async()=>{
 const claimed=await delivery.claimEmail('test-worker');expect(claimed.customerEmail).toBe(booking.customerEmail);
 expect(await delivery.claimEmail('other-worker')).toBeNull();
 await expect(model.queueResend(company,booking.bookingId,'corrected@example.com')).rejects.toThrow('being sent');
 expect(await delivery.failEmail(claimed.deliveryId,'test-worker','test failure')).toBe('retry');
 const corrected=await model.queueResend(company,booking.bookingId,'corrected@example.com');expect(corrected.emailStatus).toBe('queued');
 const next=await delivery.claimEmail('test-worker');expect(next.customerEmail).toBe('corrected@example.com');
 await delivery.finishEmail(next.deliveryId,'test-worker','logged');
 expect(await model.getBooking(company,booking.bookingId)).toMatchObject({emailStatus:'logged',emailSentAt:null});
});

// Explicitly opt-in only. All data stays in this suite's isolated schema. The
// sender below refuses any recipient other than the consented test address.
(enabled && process.env.EMAIL_LIVE_TEST_RECIPIENT === 'jlcm66@gmail.com' ? it : it.skip)(
 'rehearses authenticated booking, email correction and real provider delivery to the consenting recipient',async()=>{
  const {default:express}=await import('express');
  const {default:request}=await import('supertest');
  const {default:router}=await import('../src/routes/bm.studentAgency.routes.js');
  const {sendStudentConsultationEmail}=await import('../src/services/bm.studentConsultationEmail.service.js');
  const {processStudentConsultationEmailCycle}=await import('../src/services/bm.studentConsultationWorker.service.js');
  const savedToken=process.env.SOPHIA_RUNTIME_SERVICE_TOKEN;
  const savedCompany=process.env.SOPHIA_RUNTIME_COMPANY_ID;
  process.env.SOPHIA_RUNTIME_SERVICE_TOKEN=crypto.randomBytes(32).toString('hex');
  process.env.SOPHIA_RUNTIME_COMPANY_ID=company;
  const app=express();app.use(express.json());app.use('/api',router);app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
  const auth=`Bearer ${process.env.SOPHIA_RUNTIME_SERVICE_TOKEN}`;
  const base='/api/bm/student-agency';
  try {
   await request(app).get(`${base}/consultation-slots`).expect(401);
   const available=await request(app).get(`${base}/consultation-slots`).set('Authorization',auth).expect(200);
   const selected=available.body.consultationSlots[0];
   const input={slotId:selected.slotId,confirmedStartsAt:selected.startsAt,customerName:'Sophia Phase 5 Demo',customerEmail:'not-sent@example.invalid',includeSummary:false};
   await request(app).post(`${base}/consultation-review`).set('Authorization',auth).send(input).expect(200);
   await request(app).post(`${base}/consultation-bookings`).set('Authorization',auth).send(input).expect(400);
   const booked=await request(app).post(`${base}/consultation-bookings`).set('Authorization',auth).send({...input,confirmed:true,idempotencyKey:'phase5-live'}).expect(201);
   const id=booked.body.consultationBooking.bookingId;
   expect(booked.body.consultationBooking.emailStatus).toBe('queued');
   const recipient=process.env.EMAIL_LIVE_TEST_RECIPIENT;
   await request(app).post(`${base}/consultation-bookings/${id}/review-email`).set('Authorization',auth).send({customerEmail:recipient}).expect(200);
   await request(app).post(`${base}/consultation-bookings/${id}/email`).set('Authorization',auth).send({customerEmail:recipient,confirmed:true}).expect(200);
   const result=await processStudentConsultationEmailCycle({model:delivery,id:'phase5-live',sendEmail:async b=>{
    expect(b.bookingId).toBe(id);expect(b.customerEmail).toBe(recipient);
    return sendStudentConsultationEmail(b);
   }});
   expect(result.status).toBe('sent');
   const checked=await request(app).get(`${base}/consultation-bookings/${id}`).set('Authorization',auth).expect(200);
   expect(checked.body.consultationBooking).toMatchObject({customerEmail:recipient,emailStatus:'sent',isDemo:true});
   console.log(JSON.stringify({liveEmail:'provider_accepted',recipient,bookingId:id,startsAt:selected.startsAt,inboxReceipt:'not_verified',testCalendar:'isolated, removed after test'}));
  }finally{
   if(savedToken===undefined)delete process.env.SOPHIA_RUNTIME_SERVICE_TOKEN;else process.env.SOPHIA_RUNTIME_SERVICE_TOKEN=savedToken;
   if(savedCompany===undefined)delete process.env.SOPHIA_RUNTIME_COMPANY_ID;else process.env.SOPHIA_RUNTIME_COMPANY_ID=savedCompany;
  }
 },60000);
