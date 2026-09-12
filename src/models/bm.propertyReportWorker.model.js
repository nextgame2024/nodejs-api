import pool from "../config/db.js";

export async function acquireWorkerLock(lockId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [lockId],
    );
    if (!rows[0]?.acquired) {
      client.release();
      return null;
    }
    return {
      async release() {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function recoverExpiredJobs(maxInitialAttempts) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE bm_property_report_jobs
       SET status = CASE
             WHEN attempt_count >= $1 THEN 'daily_retry'
             ELSE 'retry'
           END,
           next_attempt_at = now(),
           locked_at = NULL,
           lease_until = NULL,
           locked_by = NULL,
           initial_attempts_exhausted_at = CASE
             WHEN attempt_count >= $1
               THEN COALESCE(initial_attempts_exhausted_at, now())
             ELSE initial_attempts_exhausted_at
           END,
           last_error = COALESCE(last_error, 'Worker lease expired'),
           updated_at = now()
       WHERE status = 'running' AND lease_until <= now()
       RETURNING report_job_id, attempt_count`,
      [maxInitialAttempts],
    );
    const exhaustedIds = rows
      .filter((row) => row.attempt_count >= maxInitialAttempts)
      .map((row) => row.report_job_id);
    if (exhaustedIds.length) {
      await client.query(
        `UPDATE bm_inspection_confirmation_deliveries
         SET status = 'fallback_queued',
             fallback_without_report = true,
             next_attempt_at = now(),
             updated_at = now()
         WHERE report_job_id = ANY($1::uuid[])
           AND status = 'waiting_report'`,
        [exhaustedIds],
      );
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNextJob({ workerId, leaseSeconds }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT report_job_id
       FROM bm_property_report_jobs
       WHERE status IN ('queued', 'retry', 'daily_retry')
         AND next_attempt_at <= now()
       ORDER BY next_attempt_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const claimed = await client.query(
      `UPDATE bm_property_report_jobs
       SET status = 'running',
           attempt_count = attempt_count + 1,
           locked_at = now(),
           lease_until = now() + make_interval(secs => $2),
           locked_by = $3,
           last_error = NULL,
           updated_at = now()
       WHERE report_job_id = $1
       RETURNING report_job_id AS "reportJobId",
         company_id AS "companyId", property_id AS "propertyId",
         report_version AS "reportVersion", report_inputs AS "reportInputs",
         attempt_count AS "attemptCount"`,
      [rows[0].report_job_id, leaseSeconds, workerId],
    );
    await client.query("COMMIT");
    return claimed.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function renewLease({ reportJobId, workerId, leaseSeconds }) {
  const { rowCount } = await pool.query(
    `UPDATE bm_property_report_jobs
     SET lease_until = now() + make_interval(secs => $3), updated_at = now()
     WHERE report_job_id = $1 AND status = 'running' AND locked_by = $2`,
    [reportJobId, workerId, leaseSeconds],
  );
  return rowCount === 1;
}

export async function markJobReady({ reportJobId, workerId, result }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ready = await client.query(
      `UPDATE bm_property_report_jobs
       SET status = 'ready', pdf_key = $3, pdf_url = $4,
           completed_at = now(), locked_at = NULL, lease_until = NULL,
           locked_by = NULL, last_error = NULL, updated_at = now()
       WHERE report_job_id = $1 AND status = 'running' AND locked_by = $2
       RETURNING report_job_id`,
      [reportJobId, workerId, result.pdfKey, result.pdfUrl],
    );
    if (!ready.rows[0]) throw new Error("Property report job lease was lost");
    await client.query(
      `UPDATE bm_inspection_confirmation_deliveries
       SET status = 'email_queued', fallback_without_report = false,
           attempt_count = CASE WHEN status = 'fallback_sent' THEN 0 ELSE attempt_count END,
           sent_at = CASE WHEN status = 'fallback_sent' THEN NULL ELSE sent_at END,
           next_attempt_at = now(), updated_at = now()
       WHERE report_job_id = $1
         AND status IN ('waiting_report', 'fallback_queued', 'fallback_sent')`,
      [reportJobId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markJobFailed({
  reportJobId,
  workerId,
  errorMessage,
  maxInitialAttempts,
  retryDelaySeconds,
  dailyRetryDelaySeconds,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const failed = await client.query(
      `UPDATE bm_property_report_jobs
       SET status = CASE
             WHEN attempt_count >= $4 THEN 'daily_retry'
             ELSE 'retry'
           END,
           next_attempt_at = now() + make_interval(secs => CASE
             WHEN attempt_count >= $4 THEN $6
             ELSE $5
           END),
           initial_attempts_exhausted_at = CASE
             WHEN attempt_count >= $4
               THEN COALESCE(initial_attempts_exhausted_at, now())
             ELSE initial_attempts_exhausted_at
           END,
           locked_at = NULL, lease_until = NULL, locked_by = NULL,
           last_error = $3, updated_at = now()
       WHERE report_job_id = $1 AND status = 'running' AND locked_by = $2
       RETURNING attempt_count AS "attemptCount",
         initial_attempts_exhausted_at AS "initialAttemptsExhaustedAt"`,
      [reportJobId, workerId, errorMessage, maxInitialAttempts,
        retryDelaySeconds, dailyRetryDelaySeconds],
    );
    if (!failed.rows[0]) throw new Error("Property report job lease was lost");
    if (failed.rows[0].attemptCount >= maxInitialAttempts) {
      await client.query(
        `UPDATE bm_inspection_confirmation_deliveries
         SET status = 'fallback_queued', fallback_without_report = true,
             next_attempt_at = now(), updated_at = now()
         WHERE report_job_id = $1 AND status = 'waiting_report'`,
        [reportJobId],
      );
    }
    await client.query("COMMIT");
    return failed.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverExpiredDeliveries() {
  const { rowCount } = await pool.query(
    `UPDATE bm_inspection_confirmation_deliveries
     SET status = CASE
           WHEN fallback_without_report THEN 'fallback_queued'
           ELSE 'email_retry'
         END,
         next_attempt_at = now(), locked_at = NULL, lease_until = NULL,
         locked_by = NULL,
         last_error = COALESCE(last_error, 'Email worker lease expired'),
         updated_at = now()
     WHERE status = 'email_sending' AND lease_until <= now()`,
  );
  return rowCount;
}

export async function claimNextDelivery({ workerId, leaseSeconds }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT d.delivery_id
       FROM bm_inspection_confirmation_deliveries d
       WHERE d.status IN ('email_queued', 'email_retry', 'fallback_queued')
         AND d.next_attempt_at <= now()
       ORDER BY d.next_attempt_at, d.created_at
       FOR UPDATE OF d SKIP LOCKED
       LIMIT 1`,
    );
    if (!rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const claimed = await client.query(
      `UPDATE bm_inspection_confirmation_deliveries d
       SET status = 'email_sending', attempt_count = d.attempt_count + 1,
           locked_at = now(),
           lease_until = now() + make_interval(secs => $2),
           locked_by = $3, last_error = NULL, updated_at = now()
       FROM bm_property_inspection_bookings b
       JOIN bm_property_inspection_slots s ON s.slot_id = b.slot_id
       JOIN bm_properties p ON p.property_id = b.property_id
       CROSS JOIN bm_property_report_jobs r
       WHERE d.delivery_id = $1 AND b.booking_id = d.booking_id
         AND r.report_job_id = d.report_job_id
       RETURNING d.delivery_id AS "deliveryId", d.booking_id AS "bookingId",
         d.attempt_count AS "attemptCount",
         d.fallback_without_report AS "fallbackWithoutReport",
         b.customer_name AS "customerName", b.customer_email AS "customerEmail",
         s.starts_at AS "startsAt", s.ends_at AS "endsAt",
         p.address AS "propertyAddress", p.suburb AS "propertySuburb",
         p.city AS "propertyCity", p.state AS "propertyState",
         p.postcode AS "propertyPostcode",
         r.status AS "reportStatus", r.pdf_key AS "pdfKey"`,
      [rows[0].delivery_id, leaseSeconds, workerId],
    );
    await client.query("COMMIT");
    return claimed.rows[0] ?? null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markDeliverySent({ deliveryId, workerId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sent = await client.query(
      `UPDATE bm_inspection_confirmation_deliveries
       SET status = CASE
             WHEN fallback_without_report THEN 'fallback_sent'
             ELSE 'sent'
           END,
           sent_at = now(), locked_at = NULL, lease_until = NULL,
           locked_by = NULL, last_error = NULL, updated_at = now()
       WHERE delivery_id = $1 AND status = 'email_sending' AND locked_by = $2
       RETURNING booking_id`,
      [deliveryId, workerId],
    );
    if (!sent.rows[0]) throw new Error("Inspection email delivery lease was lost");
    await client.query(
      `UPDATE bm_property_inspection_bookings
       SET confirmation_email_sent_at = now(), confirmation_email_error = NULL
       WHERE booking_id = $1`,
      [sent.rows[0].booking_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markDeliveryFailed({
  deliveryId,
  workerId,
  errorMessage,
  maxAttempts,
  retryDelaySeconds,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const failed = await client.query(
      `UPDATE bm_inspection_confirmation_deliveries
       SET status = CASE
             WHEN attempt_count >= $4 THEN 'failed'
             WHEN fallback_without_report THEN 'fallback_queued'
             ELSE 'email_retry'
           END,
           next_attempt_at = now() + make_interval(secs => $5),
           locked_at = NULL, lease_until = NULL, locked_by = NULL,
           last_error = $3, updated_at = now()
       WHERE delivery_id = $1 AND status = 'email_sending' AND locked_by = $2
       RETURNING booking_id, attempt_count AS "attemptCount", status`,
      [deliveryId, workerId, errorMessage, maxAttempts, retryDelaySeconds],
    );
    if (!failed.rows[0]) throw new Error("Inspection email delivery lease was lost");
    await client.query(
      `UPDATE bm_property_inspection_bookings
       SET confirmation_email_error = $2
       WHERE booking_id = $1`,
      [failed.rows[0].booking_id, errorMessage],
    );
    await client.query("COMMIT");
    return failed.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
