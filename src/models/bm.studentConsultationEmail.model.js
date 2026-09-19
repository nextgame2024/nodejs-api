import pool from '../config/db.js';
import {getBooking} from './bm.studentConsultation.model.js';
export async function acquireLock() {
  const client=await pool.connect();
  try {
    // An explicit transaction pins a backend through transaction-mode poolers.
    // Session locks can otherwise be acquired and released on different backends.
    // Use a new key so old orphaned session locks cannot block the fixed worker.
    await client.query('BEGIN');
    const {rows}=await client.query('SELECT pg_try_advisory_xact_lock(74622035) AS acquired');
    if(!rows[0].acquired){await client.query('ROLLBACK');client.release();return null;}
    return {release:async()=>{
      try{await client.query('COMMIT');client.release();}
      catch(error){client.release(true);throw error;}
    }};
  }catch(error){client.release(true);throw error;}
}
export async function claimEmail(workerId) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE bm_student_consultation_deliveries SET
      status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'retry' END,
      locked_by=NULL,lease_until=NULL,next_attempt_at=now(),last_error='Email worker lease expired',updated_at=now()
      WHERE status='sending' AND lease_until<=now()`);
    const {rows}=await client.query(`SELECT d.delivery_id,d.booking_id,d.company_id FROM bm_student_consultation_deliveries d
      JOIN bm_student_consultation_bookings b ON b.booking_id=d.booking_id AND b.company_id=d.company_id
      WHERE d.status IN ('queued','retry') AND d.next_attempt_at<=now() AND b.status='confirmed'
      ORDER BY d.next_attempt_at,d.delivery_id FOR UPDATE OF d SKIP LOCKED LIMIT 1`);
    if(!rows.length){await client.query('COMMIT');return null;}
    const row=rows[0];
    const updated=await client.query(`UPDATE bm_student_consultation_deliveries SET status='sending',attempt_count=attempt_count+1,
      locked_by=$2,lease_until=now()+interval '5 minutes',last_error=NULL,updated_at=now()
      WHERE delivery_id=$1 RETURNING attempt_count AS "attemptCount"`,[row.delivery_id,workerId]);
    const booking=await getBooking(row.company_id,row.booking_id,client);
    await client.query('COMMIT');
    return {...booking,deliveryId:row.delivery_id,attemptCount:updated.rows[0].attemptCount};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function finishEmail(deliveryId,workerId,result) {
  const {rowCount}=await pool.query(`UPDATE bm_student_consultation_deliveries SET
    status=$3,sent_at=CASE WHEN $3='sent' THEN now() ELSE NULL END,
    locked_by=NULL,lease_until=NULL,last_error=NULL,updated_at=now()
    WHERE delivery_id=$1 AND status='sending' AND locked_by=$2`,[deliveryId,workerId,result]);
  if(!rowCount)throw new Error('Consultation email lease was lost');
}
export async function failEmail(deliveryId,workerId,message) {
  const {rows}=await pool.query(`UPDATE bm_student_consultation_deliveries SET
    status=CASE WHEN attempt_count>=3 THEN 'failed' ELSE 'retry' END,
    next_attempt_at=now()+make_interval(secs => 120*power(2,least(attempt_count-1,3))::int),
    locked_by=NULL,lease_until=NULL,last_error=$3,updated_at=now()
    WHERE delivery_id=$1 AND status='sending' AND locked_by=$2 RETURNING status`,[deliveryId,workerId,message.slice(0,1000)]);
  if(!rows[0])throw new Error('Consultation email lease was lost');
  return rows[0].status;
}
