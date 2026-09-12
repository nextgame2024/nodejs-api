import pool from "../config/db.js";
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
  if (filters.minBedrooms != null) add("p.bedrooms >= ?", filters.minBedrooms);
  if (filters.maxPrice != null) add("p.price_amount <= ?", filters.maxPrice);
  params.push(filters.limit);
  const { rows } = await pool.query(
    `SELECT ${PROPERTY_SELECT} FROM bm_properties p
     WHERE ${where.join(" AND ")}
     ORDER BY p.price_amount ASC NULLS LAST, p.updatedat DESC
     LIMIT $${params.length}`,
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

export async function markInspectionConfirmationSent(companyId, bookingId, customerEmail) {
  await pool.query(
    `UPDATE bm_property_inspection_bookings
     SET customer_email = $3, confirmation_email_sent_at = now(), confirmation_email_error = NULL
     WHERE company_id = $1 AND booking_id = $2`,
    [companyId, bookingId, customerEmail],
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

const INSPECTION_BOOKING_SELECT = `
  SELECT b.booking_id AS "bookingId", b.company_id AS "companyId",
    b.property_id AS "propertyId",
    b.slot_id AS "slotId", b.customer_name AS "customerName",
    b.customer_email AS "customerEmail", b.customer_phone AS "customerPhone",
    b.status, b.createdat AS "createdAt",
    b.confirmation_email_sent_at AS "confirmationEmailSentAt",
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

async function attachSaleReportDelivery(client, booking, reportVersion) {
  if (booking.listingType !== "sale") return booking;
  if (!reportVersion) throw new Error("Town Planner report version is required");

  const reportDelivery = await enqueueSaleReportDelivery(client, {
    companyId: booking.companyId,
    bookingId: booking.bookingId,
    property: booking,
    reportVersion,
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
