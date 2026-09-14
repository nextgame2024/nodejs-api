// Only the fixed, synthetic seed properties are eligible for automatic slots.
// Real agency listings must continue to use their own inspection schedules.
export const DEMO_PROPERTY_IDS = Array.from({ length: 40 }, (_, index) =>
  `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const demoIds = new Set(DEMO_PROPERTY_IDS);
export const isDemoPropertyId = (propertyId) => demoIds.has(propertyId);

// Caller owns a transaction. The property row lock serializes refreshes across
// API replicas; existing slots (including full/cancelled ones) are never edited.
export async function refreshDemoInspectionSlots(client, companyId, propertyId) {
  if (!isDemoPropertyId(propertyId)) return 0;
  const property = await client.query(
    `SELECT property_id FROM bm_properties
     WHERE property_id = $1 AND company_id = $2 AND status = 'available'
       AND agent_email = 'alex.morgan@example.com'
     FOR UPDATE`,
    [propertyId, companyId],
  );
  if (!property.rows.length) return 0;
  const hour = DEMO_PROPERTY_IDS.indexOf(propertyId) % 2 ? 14 : 10;
  const result = await client.query(
    `WITH dates AS (
       SELECT (now() AT TIME ZONE 'Australia/Brisbane')::date + day AS local_date
       FROM generate_series(0, 13) AS day
     ), candidates AS (
       SELECT (local_date + make_time($2::int, 30, 0))
         AT TIME ZONE 'Australia/Brisbane' AS starts_at
       FROM dates WHERE EXTRACT(ISODOW FROM local_date) IN (2, 4, 6)
     )
     INSERT INTO bm_property_inspection_slots
       (property_id, starts_at, ends_at, capacity)
     SELECT $1, c.starts_at, c.starts_at + interval '30 minutes', 10
     FROM candidates c
     WHERE c.starts_at > now()
       AND NOT EXISTS (
         SELECT 1 FROM bm_property_inspection_slots s
         WHERE s.property_id = $1 AND s.starts_at = c.starts_at
       )`,
    [propertyId, hour],
  );
  return result.rowCount;
}
