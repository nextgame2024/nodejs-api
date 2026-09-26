import pool from "../config/db.js";
import { isDemoPropertyId, refreshDemoInspectionSlots } from "./bm.demoInspectionSlots.model.js";
import { enqueueSaleReportDelivery } from "./bm.propertyReportJobs.model.js";

const PROPERTY_SELECT = `
  p.property_id AS "propertyId", p.company_id AS "companyId",
  p.listing_type AS "listingType", p.property_type AS "propertyType",
  p.status, p.title, p.address, p.suburb, p.city, p.state, p.postcode,
  p.latitude::float8 AS latitude, p.longitude::float8 AS longitude,
  p.price_display AS "priceDisplay", p.price_amount::float8 AS "priceAmount",
  p.bedrooms, p.bathrooms, p.car_spaces AS "carSpaces",
  p.description, p.features, p.agent_name AS "agentName",
  p.agent_email AS "agentEmail", p.agent_phone AS "agentPhone",
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'mediaId', m.media_id, 'url', m.media_url, 'altText', m.alt_text,
      'sortOrder', m.sort_order
    ) ORDER BY m.sort_order, m.createdat)
    FROM bm_property_media m WHERE m.property_id = p.property_id
  ), '[]'::jsonb) AS media
`;

export async function searchProperties(companyId, filters) {
  const params = [companyId];
  const where = ["p.company_id = $1", "p.status = 'available'"];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const addLocation = (value) => {
    params.push(`%${value}%`);
    where.push(`(p.city ILIKE $${params.length} OR p.suburb ILIKE $${params.length})`);
  };
  if (filters.listingType) add("p.listing_type = ?", filters.listingType);
  if (filters.propertyType) add("LOWER(p.property_type) = LOWER(?)", filters.propertyType);
  if (filters.location) {
    for (const location of filters.location.split(",").map((value) => value.trim()).filter(Boolean)) {
      addLocation(location);
    }
  } else if (filters.city && filters.suburb) {
    add("p.city ILIKE ?", `%${filters.city}%`);
    add("p.suburb ILIKE ?", `%${filters.suburb}%`);
  } else {
    const location = filters.city || filters.suburb;
    if (location) addLocation(location);
  }
  if (filters.suburbs?.length) {
    params.push(filters.suburbs.map((value) => value.toLowerCase()));
    where.push(`LOWER(p.suburb) = ANY($${params.length}::text[])`);
  }
  if (filters.minBedrooms != null) add("p.bedrooms >= ?", filters.minBedrooms);
  if (filters.minPrice != null) add("p.price_amount >= ?", filters.minPrice);
  if (filters.maxPrice != null) add("p.price_amount <= ?", filters.maxPrice);
  params.push(filters.limit);
  const limitParameter = params.length;
  params.push(filters.offset ?? 0);
  const { rows } = await pool.query(
    `SELECT ${PROPERTY_SELECT} FROM bm_properties p
     WHERE ${where.join(" AND ")}
     ORDER BY p.price_amount ASC NULLS LAST, p.updatedat DESC
     LIMIT $${limitParameter} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

export async function getProperty(companyId, propertyId) {
  const { rows } = await pool.query(
    `SELECT ${PROPERTY_SELECT} FROM bm_properties p
     WHERE p.company_id = $1 AND p.property_id = $2 LIMIT 1`,
    [companyId, propertyId],
  );
  return rows[0] ?? null;
}

export async function listInspectionSlots(companyId, propertyId, from, to) {
  if (isDemoPropertyId(propertyId)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await refreshDemoInspectionSlots(client, companyId, propertyId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const { rows } = await pool.query(
    `SELECT s.slot_id AS "slotId", s.property_id AS "propertyId",
       s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.capacity,
       s.capacity - COUNT(b.booking_id)::int AS "placesAvailable"
     FROM bm_property_inspection_slots s
     JOIN bm_properties p ON p.property_id = s.property_id AND p.company_id = $1
     LEFT JOIN bm_property_inspection_bookings b
       ON b.slot_id = s.slot_id AND b.status = 'confirmed'
     WHERE s.property_id = $2 AND s.status = 'open'
       AND s.starts_at >= $3::timestamptz AND s.starts_at <= $4::timestamptz
     GROUP BY s.slot_id
     HAVING COUNT(b.booking_id) < s.capacity
     ORDER BY s.starts_at ASC`,
    [companyId, propertyId, from, to],
  );
  return rows;
}

export async function getInspectionSlot(companyId, propertyId, slotId) {
  const { rows } = await pool.query(
    `SELECT s.slot_id AS "slotId", s.property_id AS "propertyId",
       s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.capacity,
       GREATEST(s.capacity - COUNT(b.booking_id)::int, 0) AS "placesAvailable",
       s.status
     FROM bm_property_inspection_slots s
     JOIN bm_properties p ON p.property_id = s.property_id AND p.company_id = $1
     LEFT JOIN bm_property_inspection_bookings b
       ON b.slot_id = s.slot_id AND b.status = 'confirmed'
     WHERE s.property_id = $2 AND s.slot_id = $3
     GROUP BY s.slot_id
     LIMIT 1`,
    [companyId, propertyId, slotId],
  );
  return rows[0] ?? null;
}

export async function createInspectionBooking(companyId, input, workflow = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `${INSPECTION_BOOKING_SELECT}
       WHERE b.company_id = $1 AND b.idempotency_key = $2`,
      [companyId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      const result = await attachSaleReportDelivery(
        client,
        existing.rows[0],
        workflow.reportVersion,
        workflow.workflowVersionId,
      );
      await client.query("COMMIT");
      return result;
    }

    const slotResult = await client.query(
      `SELECT s.capacity, s.status, s.starts_at AS "startsAt"
       FROM bm_property_inspection_slots s
       JOIN bm_properties p ON p.property_id = s.property_id
       WHERE p.company_id = $1 AND p.property_id = $2 AND s.slot_id = $3
       FOR UPDATE OF s`,
      [companyId, input.propertyId, input.slotId],
    );
    const slot = slotResult.rows[0];
    if (!slot || slot.status !== "open") return await rollbackResult(client, "SLOT_UNAVAILABLE");
    if (new Date(slot.startsAt).getTime() !== new Date(input.confirmedStartsAt).getTime()) {
      return await rollbackResult(client, "SLOT_TIME_MISMATCH");
    }
    const count = await client.query(
      `SELECT COUNT(*)::int AS count FROM bm_property_inspection_bookings
       WHERE slot_id = $1 AND status = 'confirmed'`,
      [input.slotId],
    );
    if (count.rows[0].count >= slot.capacity) return await rollbackResult(client, "SLOT_FULL");

    const { rows } = await client.query(
      `INSERT INTO bm_property_inspection_bookings (
         company_id, property_id, slot_id, customer_name, customer_email,
         customer_phone, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING booking_id AS "bookingId"`,
      [companyId, input.propertyId, input.slotId, input.customerName,
        input.customerEmail, input.customerPhone ?? null, input.idempotencyKey],
    );
    const booking = await client.query(
      `${INSPECTION_BOOKING_SELECT}
       WHERE b.company_id = $1 AND b.booking_id = $2`,
      [companyId, rows[0].bookingId],
    );
    const result = await attachSaleReportDelivery(
      client,
      booking.rows[0],
      workflow.reportVersion,
      workflow.workflowVersionId,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getInspectionBooking(companyId, bookingId) {
  const { rows } = await pool.query(
    `${INSPECTION_BOOKING_SELECT}
     WHERE b.company_id = $1 AND b.booking_id = $2`,
    [companyId, bookingId],
  );
  return rows[0] ?? null;
}

export async function findInspectionBookingByCommand(companyId, commandId) {
  const { rows } = await pool.query(
    `${INSPECTION_BOOKING_SELECT}
     WHERE b.company_id = $1 AND b.idempotency_key = $2`,
    [companyId, commandId],
  );
  return rows[0] ?? null;
}

export async function getInspectionDeliveryStatus(companyId, operationRef) {
  const { rows } = await pool.query(
    `SELECT d.delivery_id AS "deliveryId", d.booking_id AS "bookingId",
       d.report_job_id AS "reportJobId", d.status, d.attempt_count AS "attemptCount",
       d.sent_at AS "sentAt", d.last_error AS "lastError", d.updated_at AS "updatedAt",
       d.provider_key AS "providerKey", d.provider_message_id AS "providerMessageId",
       d.provider_accepted_at AS "providerAcceptedAt",
       d.verified_delivered_at AS "verifiedDeliveredAt",
       r.status AS "reportStatus"
     FROM bm_inspection_confirmation_deliveries d
     JOIN bm_property_report_jobs r ON r.report_job_id = d.report_job_id
     WHERE d.company_id = $1 AND (d.delivery_id::text = $2 OR d.booking_id::text = $2)
     LIMIT 1`,
    [companyId, operationRef],
  );
  return rows[0] ?? null;
}

export async function getInspectionEmailCommand(companyId, commandId) {
  const { rows } = await pool.query(
    `SELECT command_id AS "commandId", booking_id AS "bookingId", status, response,
       last_error AS "lastError", attempt_count AS "attemptCount", updated_at AS "updatedAt"
     FROM bm_inspection_email_commands
     WHERE company_id = $1 AND command_id = $2`,
    [companyId, commandId],
  );
  return rows[0] ?? null;
}

export async function getPropertyWorkflowStatus(companyId, workflowRef) {
  const delivery = await pool.query(
    `SELECT d.delivery_id AS "workflowRef", d.status AS "deliveryStatus",
       d.workflow_version_id AS "workflowVersionId", d.attempt_count AS "deliveryAttemptCount",
       d.last_error AS "deliveryError", d.updated_at AS "updatedAt",
       r.report_job_id AS "reportJobId", r.status AS "reportStatus",
       r.attempt_count AS "reportAttemptCount", r.completed_at AS "completedAt"
     FROM bm_inspection_confirmation_deliveries d
     JOIN bm_property_report_jobs r ON r.report_job_id = d.report_job_id
     WHERE d.company_id = $1 AND d.delivery_id::text = $2`,
    [companyId, workflowRef],
  );
  if (delivery.rows[0]) return delivery.rows[0];
  const report = await pool.query(
    `SELECT report_job_id AS "workflowRef", status AS "reportStatus",
       attempt_count AS "reportAttemptCount", last_error AS "reportError",
       completed_at AS "completedAt", updated_at AS "updatedAt"
     FROM bm_property_report_jobs WHERE company_id = $1 AND report_job_id::text = $2`,
    [companyId, workflowRef],
  );
  return report.rows[0] ?? null;
}

export async function recordInspectionConfirmationProviderResult(companyId, bookingId, customerEmail, providerResult) {
  await pool.query(
    `UPDATE bm_property_inspection_bookings
     SET customer_email = $3,
         confirmation_email_provider_key = $4,
         confirmation_email_provider_message_id = $5,
         confirmation_email_accepted_at = CASE WHEN $6 = 'accepted' THEN now() ELSE confirmation_email_accepted_at END,
         confirmation_email_previewed_at = CASE WHEN $6 = 'preview' THEN now() ELSE confirmation_email_previewed_at END,
         confirmation_email_error = NULL
     WHERE company_id = $1 AND booking_id = $2`,
    [companyId, bookingId, customerEmail, providerResult.provider,
      providerResult.providerMessageId ?? null, providerResult.state],
  );
}

export async function markInspectionConfirmationFailed(companyId, bookingId, message) {
  await pool.query(
    `UPDATE bm_property_inspection_bookings
     SET confirmation_email_error = $3
     WHERE company_id = $1 AND booking_id = $2`,
    [companyId, bookingId, message],
  );
}

export async function queueSaleInspectionConfirmation(
  companyId,
  bookingId,
  customerEmail,
  forceResend,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT d.delivery_id, d.status, r.status AS report_status,
         r.pdf_key, r.initial_attempts_exhausted_at
       FROM bm_inspection_confirmation_deliveries d
       JOIN bm_property_report_jobs r ON r.report_job_id = d.report_job_id
       WHERE d.company_id = $1 AND d.booking_id = $2
       FOR UPDATE OF d`,
      [companyId, bookingId],
    );
    const delivery = current.rows[0];
    if (!delivery) throw new Error("BUY inspection confirmation delivery not found");

    await client.query(
      `UPDATE bm_property_inspection_bookings
       SET customer_email = $3,
           confirmation_email_sent_at = CASE
             WHEN $4 THEN NULL ELSE confirmation_email_sent_at
           END,
           confirmation_email_error = CASE
             WHEN $4 THEN NULL ELSE confirmation_email_error
           END
       WHERE company_id = $1 AND booking_id = $2`,
      [companyId, bookingId, customerEmail, forceResend],
    );

    if (forceResend) {
      const reportReady = delivery.report_status === "ready" && delivery.pdf_key;
      const reportExhausted = !!delivery.initial_attempts_exhausted_at && !reportReady;
      const status = reportReady
        ? "email_queued"
        : reportExhausted
          ? "fallback_queued"
          : "waiting_report";
      const updated = await client.query(
        `UPDATE bm_inspection_confirmation_deliveries
         SET status = $3, fallback_without_report = $4,
             attempt_count = 0, next_attempt_at = now(), sent_at = NULL,
             locked_at = NULL, lease_until = NULL, locked_by = NULL,
             last_error = NULL, updated_at = now()
         WHERE company_id = $1 AND booking_id = $2
         RETURNING status`,
        [companyId, bookingId, status, reportExhausted],
      );
      delivery.status = updated.rows[0].status;
    }

    await client.query("COMMIT");
    return {
      deliveryStatus: delivery.status,
      reportStatus: delivery.report_status,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function beginInspectionEmailCommand(companyId, bookingId, customerEmail, commandId) {
  const inserted = await pool.query(
    `INSERT INTO bm_inspection_email_commands
       (command_id, company_id, booking_id, customer_email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (command_id) DO NOTHING
     RETURNING command_id, status, response`,
    [commandId, companyId, bookingId, customerEmail],
  );
  if (inserted.rows[0]) return { ...inserted.rows[0], created: true };
  const existing = await pool.query(
    `SELECT command_id, company_id, booking_id, customer_email, status, response
     FROM bm_inspection_email_commands WHERE command_id = $1`,
    [commandId],
  );
  return { ...existing.rows[0], created: false };
}

export async function retryInspectionEmailCommand(commandId) {
  const result = await pool.query(
    `UPDATE bm_inspection_email_commands
     SET status = 'executing', attempt_count = attempt_count + 1,
         last_error = NULL, updated_at = now()
     WHERE command_id = $1 AND status = 'failed'
     RETURNING command_id`,
    [commandId],
  );
  return !!result.rows[0];
}

export async function completeInspectionEmailCommand(commandId, response) {
  await pool.query(
    `UPDATE bm_inspection_email_commands
     SET status = 'completed', response = $2::jsonb, last_error = NULL, updated_at = now()
     WHERE command_id = $1 AND status = 'executing'`,
    [commandId, JSON.stringify(response)],
  );
}

export async function failInspectionEmailCommand(commandId, error, ambiguous = false) {
  await pool.query(
    `UPDATE bm_inspection_email_commands
     SET status = $2, last_error = $3, updated_at = now()
     WHERE command_id = $1 AND status = 'executing'`,
    [commandId, ambiguous ? 'unknown' : 'failed', String(error).slice(0, 500)],
  );
}

export async function getInspectionPrivacyDataByCommands(companyId, commandIds) {
  const commands = commandIds.map(sophiaCommandId);
  const { rows } = await pool.query(
    `WITH matched_bookings AS (
       SELECT booking_id FROM bm_property_inspection_bookings
       WHERE company_id = $1 AND idempotency_key = ANY($2::text[])
       UNION
       SELECT booking_id FROM bm_inspection_email_commands
       WHERE company_id = $1 AND command_id = ANY($2::text[])
     )
     SELECT b.booking_id AS "bookingId", b.customer_name AS "customerName",
       b.customer_email AS "customerEmail", b.customer_phone AS "customerPhone",
       b.status, b.createdat AS "createdAt",
       d.status AS "deliveryStatus", d.provider_key AS "deliveryProvider",
       d.provider_message_id AS "providerMessageId",
       r.status AS "reportStatus", r.report_version AS "reportVersion"
     FROM matched_bookings m
     JOIN bm_property_inspection_bookings b ON b.booking_id = m.booking_id AND b.company_id = $1
     LEFT JOIN bm_inspection_confirmation_deliveries d ON d.booking_id = b.booking_id AND d.company_id = $1
     LEFT JOIN bm_property_report_jobs r ON r.report_job_id = d.report_job_id AND r.company_id = $1
     ORDER BY b.createdat, b.booking_id`,
    [companyId, commands],
  );
  return rows;
}

export async function redactInspectionPrivacyDataByCommands(companyId, commandIds) {
  const commands = commandIds.map(sophiaCommandId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [companyId]);
    const matched = await client.query(
      `SELECT DISTINCT booking_id FROM (
         SELECT booking_id FROM bm_property_inspection_bookings
         WHERE company_id = $1 AND idempotency_key = ANY($2::text[])
         UNION ALL
         SELECT booking_id FROM bm_inspection_email_commands
         WHERE company_id = $1 AND command_id = ANY($2::text[])
       ) matches`,
      [companyId, commands],
    );
    const bookingIds = matched.rows.map((row) => row.booking_id);
    if (!bookingIds.length) {
      await client.query("COMMIT");
      return { bookingsRedacted: 0, emailCommandsRedacted: 0, deliveriesRedacted: 0 };
    }
    const bookings = await client.query(
      `UPDATE bm_property_inspection_bookings
       SET customer_name = 'Deleted customer',
           customer_email = 'deleted+' || booking_id::text || '@privacy.invalid',
           customer_phone = NULL,
           confirmation_email_provider_message_id = NULL,
           confirmation_email_error = NULL
       WHERE company_id = $1 AND booking_id = ANY($2::uuid[])
       RETURNING booking_id`,
      [companyId, bookingIds],
    );
    const emailCommands = await client.query(
      `UPDATE bm_inspection_email_commands
       SET customer_email = 'deleted+' || booking_id::text || '@privacy.invalid',
           response = '{"redacted":true}'::jsonb, last_error = NULL, updated_at = now()
       WHERE company_id = $1 AND booking_id = ANY($2::uuid[])
       RETURNING command_id`,
      [companyId, bookingIds],
    );
    const deliveries = await client.query(
      `UPDATE bm_inspection_confirmation_deliveries
       SET provider_message_id = NULL, last_error = NULL, updated_at = now()
       WHERE company_id = $1 AND booking_id = ANY($2::uuid[])
       RETURNING delivery_id`,
      [companyId, bookingIds],
    );
    await client.query("COMMIT");
    return {
      bookingsRedacted: bookings.rowCount,
      emailCommandsRedacted: emailCommands.rowCount,
      deliveriesRedacted: deliveries.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sophiaCommandId(value) {
  return String(value).startsWith("sophia:") ? String(value) : `sophia:${value}`;
}

const INSPECTION_BOOKING_SELECT = `
  SELECT b.booking_id AS "bookingId", b.company_id AS "companyId",
    b.property_id AS "propertyId",
    b.slot_id AS "slotId", b.customer_name AS "customerName",
    b.customer_email AS "customerEmail", b.customer_phone AS "customerPhone",
    b.status, b.createdat AS "createdAt",
    b.confirmation_email_sent_at AS "confirmationEmailSentAt",
    b.confirmation_email_provider_key AS "confirmationEmailProviderKey",
    b.confirmation_email_provider_message_id AS "confirmationEmailProviderMessageId",
    b.confirmation_email_accepted_at AS "confirmationEmailAcceptedAt",
    b.confirmation_email_previewed_at AS "confirmationEmailPreviewedAt",
    b.confirmation_email_verified_delivered_at AS "confirmationEmailVerifiedDeliveredAt",
    b.confirmation_email_error AS "confirmationEmailError",
    s.starts_at AS "startsAt", s.ends_at AS "endsAt",
    p.listing_type AS "listingType",
    p.address AS "propertyAddress", p.suburb AS "propertySuburb",
    p.city AS "propertyCity", p.state AS "propertyState",
    p.postcode AS "propertyPostcode",
    p.latitude::float8 AS "propertyLatitude",
    p.longitude::float8 AS "propertyLongitude",
    p.updatedat AS "propertyUpdatedAt"
  FROM bm_property_inspection_bookings b
  JOIN bm_property_inspection_slots s ON s.slot_id = b.slot_id
  JOIN bm_properties p ON p.property_id = b.property_id
`;

async function attachSaleReportDelivery(client, booking, reportVersion, workflowVersionId) {
  if (booking.listingType !== "sale") return booking;
  if (!reportVersion) throw new Error("Town Planner report version is required");

  const reportDelivery = await enqueueSaleReportDelivery(client, {
    companyId: booking.companyId,
    bookingId: booking.bookingId,
    property: booking,
    reportVersion,
    workflowVersionId,
  });
  return { ...booking, reportDelivery };
}

async function rollbackResult(client, code) {
  await client.query("ROLLBACK");
  return { errorCode: code };
}

export async function searchKnowledge(companyId, query, category, limit) {
  const params = [companyId];
  const where = ["company_id = $1", "active = true"];
  if (category) {
    params.push(category);
    where.push(`LOWER(category) = LOWER($${params.length})`);
  }
  if (query) {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((term) => term.length > 2) || [];
    params.push(terms.length ? terms.join(" OR ") : query);
    where.push(`to_tsvector('english', category || ' ' || question || ' ' || answer)
      @@ websearch_to_tsquery('english', $${params.length})`);
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT knowledge_id AS "knowledgeId", category, question, answer,
       source_url AS "sourceUrl", jurisdiction, reviewed_at AS "reviewedAt"
     FROM bm_agency_knowledge WHERE ${where.join(" AND ")}
     ORDER BY reviewed_at DESC NULLS LAST, createdat ASC LIMIT $${params.length}`,
    params,
  );
  return rows;
}
