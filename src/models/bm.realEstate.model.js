import pool from "../config/db.js";

const PROPERTY_SELECT = `
  p.property_id AS "propertyId", p.company_id AS "companyId",
  p.listing_type AS "listingType", p.property_type AS "propertyType",
  p.status, p.title, p.address, p.suburb, p.state, p.postcode,
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
  if (filters.listingType) add("p.listing_type = ?", filters.listingType);
  if (filters.propertyType) add("LOWER(p.property_type) = LOWER(?)", filters.propertyType);
  if (filters.suburb) add("p.suburb ILIKE ?", `%${filters.suburb}%`);
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

export async function createInspectionBooking(companyId, input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT booking_id AS "bookingId", property_id AS "propertyId",
         slot_id AS "slotId", customer_name AS "customerName",
         customer_email AS "customerEmail", customer_phone AS "customerPhone",
         status, createdat AS "createdAt"
       FROM bm_property_inspection_bookings
       WHERE company_id = $1 AND idempotency_key = $2`,
      [companyId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return existing.rows[0];
    }

    const slotResult = await client.query(
      `SELECT s.capacity, s.status
       FROM bm_property_inspection_slots s
       JOIN bm_properties p ON p.property_id = s.property_id
       WHERE p.company_id = $1 AND p.property_id = $2 AND s.slot_id = $3
       FOR UPDATE OF s`,
      [companyId, input.propertyId, input.slotId],
    );
    const slot = slotResult.rows[0];
    if (!slot || slot.status !== "open") return await rollbackResult(client, "SLOT_UNAVAILABLE");
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
       RETURNING booking_id AS "bookingId", property_id AS "propertyId",
         slot_id AS "slotId", customer_name AS "customerName",
         customer_email AS "customerEmail", customer_phone AS "customerPhone",
         status, createdat AS "createdAt"`,
      [companyId, input.propertyId, input.slotId, input.customerName,
        input.customerEmail, input.customerPhone ?? null, input.idempotencyKey],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
