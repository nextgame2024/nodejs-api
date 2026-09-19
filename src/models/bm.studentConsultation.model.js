import pool from '../config/db.js';

export const conflict = (message, status = 409) => Object.assign(new Error(message), { status });
const SLOT = `s.slot_id AS "slotId", s.starts_at AS "startsAt", s.ends_at AS "endsAt",
  a.adviser_id AS "adviserId", a.adviser_name AS "adviserName", a.service_name AS "serviceName",
  a.meeting_details AS "meetingDetails", a.time_zone AS "timeZone", a.is_demo AS "isDemo"`;
const BOOKING = `SELECT b.booking_id AS "bookingId", b.status, b.slot_id AS "slotId",
  b.customer_name AS "customerName", b.customer_email AS "customerEmail",
  b.enquiry_summary AS "enquirySummary", b.include_summary AS "includeSummary", b.source_links AS "sourceLinks",
  b.idempotency_key AS "idempotencyKey", ${SLOT},
  d.status AS "emailStatus", d.sent_at AS "emailSentAt"
  FROM bm_student_consultation_bookings b
  JOIN bm_student_consultation_slots s ON s.slot_id=b.slot_id AND s.company_id=b.company_id
  JOIN bm_student_advisers a ON a.adviser_id=s.adviser_id AND a.company_id=s.company_id
  LEFT JOIN bm_student_consultation_deliveries d ON d.booking_id=b.booking_id AND d.company_id=b.company_id`;

export async function refreshDemoSlots(companyId) {
  // Only expressly configured demo calendars are replenished, never real ones.
  await pool.query(`INSERT INTO bm_student_consultation_slots(company_id,adviser_id,starts_at,ends_at)
    SELECT a.company_id,a.adviser_id,t.starts_at,t.starts_at+interval '30 minutes'
    FROM bm_student_advisers a
    CROSS JOIN generate_series(1,14) AS day
    CROSS JOIN (VALUES (10),(14)) AS hour(h)
    CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE a.time_zone)::date+day+make_time(hour.h,0,0)) AT TIME ZONE a.time_zone AS starts_at) t
    WHERE a.company_id=$1 AND a.is_demo AND a.active
      AND extract(isodow FROM t.starts_at AT TIME ZONE a.time_zone) BETWEEN 1 AND 5
    ON CONFLICT(adviser_id,starts_at) DO NOTHING`, [companyId]);
}
export async function listSlots(companyId) {
  await refreshDemoSlots(companyId);
  const { rows } = await pool.query(`SELECT ${SLOT},s.capacity-count(b.booking_id)::int AS "placesAvailable"
    FROM bm_student_consultation_slots s
    JOIN bm_student_advisers a ON a.adviser_id=s.adviser_id AND a.company_id=s.company_id
    LEFT JOIN bm_student_consultation_bookings b ON b.slot_id=s.slot_id AND b.status='confirmed'
    WHERE s.company_id=$1 AND a.active AND s.status='open'
      AND s.starts_at>now() AND s.starts_at<=now()+interval '14 days'
    GROUP BY s.slot_id,a.adviser_id HAVING count(b.booking_id)<s.capacity
    ORDER BY s.starts_at,a.adviser_name LIMIT 12`, [companyId]);
  return rows;
}
export async function getSlot(companyId,slotId,client=pool,lock=false) {
  const {rows}=await client.query(`SELECT ${SLOT},s.capacity,s.status,a.active,
    s.starts_at>now() AS future FROM bm_student_consultation_slots s
    JOIN bm_student_advisers a ON a.adviser_id=s.adviser_id AND a.company_id=s.company_id
    WHERE s.company_id=$1 AND s.slot_id=$2 ${lock ? 'FOR UPDATE OF s' : ''}`,[companyId,slotId]);
  return rows[0]||null;
}
export async function getBooking(companyId,bookingId,client=pool) {
  const {rows}=await client.query(`${BOOKING} WHERE b.company_id=$1 AND b.booking_id=$2`,[companyId,bookingId]);
  return rows[0]||null;
}
export async function createBooking(companyId,input) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const slot=await getSlot(companyId,input.slotId,client,true);
    if(!slot)throw conflict('Consultation slot not found',404);
    const existing=await client.query(`${BOOKING} WHERE b.company_id=$1 AND b.idempotency_key=$2`,[companyId,input.idempotencyKey]);
    if(existing.rows[0]) {
      const b=existing.rows[0];
      if(b.slotId!==input.slotId || b.customerName!==input.customerName || b.customerEmail!==input.customerEmail ||
          +new Date(b.startsAt)!==+new Date(input.confirmedStartsAt) || b.includeSummary!==input.includeSummary ||
          b.enquirySummary!==input.enquirySummary || JSON.stringify(b.sourceLinks)!==JSON.stringify(input.sourceLinks)) {
        throw conflict('This booking request was already used with different details');
      }
      await client.query('COMMIT');return b;
    }
    if(!slot.future || !slot.active || slot.status!=='open')throw conflict('This consultation time is no longer available');
    if(+new Date(slot.startsAt)!==+new Date(input.confirmedStartsAt))throw conflict('The confirmed consultation time no longer matches');
    const count=await client.query("SELECT count(*)::int AS count FROM bm_student_consultation_bookings WHERE slot_id=$1 AND status='confirmed'",[input.slotId]);
    if(count.rows[0].count>=slot.capacity)throw conflict('This consultation is fully booked');
    const inserted=await client.query(`INSERT INTO bm_student_consultation_bookings
      (company_id,slot_id,customer_name,customer_email,enquiry_summary,include_summary,source_links,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING booking_id`,
      [companyId,input.slotId,input.customerName,input.customerEmail,input.enquirySummary,input.includeSummary,JSON.stringify(input.sourceLinks),input.idempotencyKey]);
    const id=inserted.rows[0].booking_id;
    await client.query('INSERT INTO bm_student_consultation_deliveries(company_id,booking_id) VALUES ($1,$2)',[companyId,id]);
    const booking=await getBooking(companyId,id,client);
    await client.query('COMMIT');return booking;
  } catch(error) {
    await client.query('ROLLBACK');
    if(error.code==='23505')throw conflict('A booking already exists for this email or request');
    throw error;
  } finally {client.release();}
}
export async function queueResend(companyId,bookingId,customerEmail) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const locked=await client.query(`SELECT d.status,d.lease_until>now() AS busy FROM bm_student_consultation_deliveries d
      WHERE d.company_id=$1 AND d.booking_id=$2 FOR UPDATE`,[companyId,bookingId]);
    if(!locked.rows[0])throw conflict('Consultation booking not found',404);
    if(locked.rows[0].status==='sending' && locked.rows[0].busy)throw conflict('The email is being sent. Please try the correction again shortly.');
    const booking=await getBooking(companyId,bookingId,client);
    if(booking.status!=='confirmed')throw conflict('This consultation is not confirmed');
    await client.query('UPDATE bm_student_consultation_bookings SET customer_email=$3 WHERE company_id=$1 AND booking_id=$2',[companyId,bookingId,customerEmail]);
    await client.query(`UPDATE bm_student_consultation_deliveries SET status='queued',attempt_count=0,next_attempt_at=now(),
      locked_by=NULL,lease_until=NULL,sent_at=NULL,last_error=NULL,updated_at=now() WHERE company_id=$1 AND booking_id=$2`,[companyId,bookingId]);
    const result=await getBooking(companyId,bookingId,client);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');if(error.code==='23505')throw conflict('This email is already booked for this consultation');throw error;}
  finally{client.release();}
}
