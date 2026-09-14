import { afterAll, beforeAll, expect, it, jest } from "@jest/globals";
import pg from "pg";
import { DEMO_PROPERTY_IDS, refreshDemoInspectionSlots } from "../src/models/bm.demoInspectionSlots.model.js";

// Run with INSPECTION_SQL_TEST_DATABASE=1 and dotenv loaded. All fixture writes
// stay in temporary tables on one connection and are rolled back afterwards.
const enabled = process.env.INSPECTION_SQL_TEST_DATABASE === "1";
const database = enabled ? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  connectionTimeoutMillis: 10_000,
}) : null;
let client;
const companyId = "90000000-0000-4000-8000-000000000001";
jest.unstable_mockModule("../src/config/db.js", () => ({ default: {
  query: (...args) => client.query(...args),
  connect: async () => ({
    query: (sql, values) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)
      ? Promise.resolve({ rows: [] }) : client.query(sql, values),
    release() {},
  }),
} }));
const { listInspectionSlots } = await import("../src/models/bm.realEstate.model.js");
beforeAll(async () => {
  if (!enabled) return;
  client = await database.connect();
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE bm_properties (
    property_id uuid PRIMARY KEY, company_id uuid, status text, agent_email text
  ); CREATE TEMP TABLE bm_property_inspection_slots (
    slot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid,
    starts_at timestamptz, ends_at timestamptz, capacity int, status text DEFAULT 'open'
  ); CREATE TEMP TABLE bm_property_inspection_bookings (
    booking_id uuid DEFAULT gen_random_uuid(), slot_id uuid, status text
  )`);
  for (const propertyId of DEMO_PROPERTY_IDS.slice(0, 3)) {
    await client.query("INSERT INTO bm_properties VALUES ($1,$2,'available',$3)",
      [propertyId, companyId, propertyId === DEMO_PROPERTY_IDS[2] ? "real-agent@example.com" : "alex.morgan@example.com"]);
  }
});
afterAll(async () => {
  if (client) { await client.query("ROLLBACK"); client.release(); }
  await database?.end();
});
const integration = enabled ? it : it.skip;
integration("returns future Brisbane slots for both seeded rent and sale properties", async () => {
  for (const propertyId of [DEMO_PROPERTY_IDS[0], DEMO_PROPERTY_IDS[5]]) {
    // The sixth seeded property is a sale listing.
    if (propertyId === DEMO_PROPERTY_IDS[5]) {
      await client.query("INSERT INTO bm_properties VALUES ($1,$2,'available','alex.morgan@example.com')", [propertyId, companyId]);
    }
    const from = new Date();
    const slots = await listInspectionSlots(companyId, propertyId, from.toISOString(), new Date(+from + 14 * 86400000).toISOString());
    expect(slots.length).toBeGreaterThanOrEqual(5);
    expect(slots.every(slot => slot.startsAt > from && slot.placesAvailable === 10)).toBe(true);
    const label = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", hour: "2-digit", minute: "2-digit", hour12: false });
    expect(label.format(slots[0].startsAt)).toBe(propertyId === DEMO_PROPERTY_IDS[0] ? "10:30" : "14:30");
    expect(await refreshDemoInspectionSlots(client, companyId, propertyId)).toBe(0);
  }
});
integration("preserves booked and cancelled slots and respects capacity on refresh", async () => {
  const propertyId = DEMO_PROPERTY_IDS[0];
  const { rows: slots } = await client.query("SELECT * FROM bm_property_inspection_slots WHERE property_id=$1 ORDER BY starts_at", [propertyId]);
  await client.query("UPDATE bm_property_inspection_slots SET capacity=1 WHERE slot_id=$1", [slots[0].slot_id]);
  await client.query("INSERT INTO bm_property_inspection_bookings (slot_id,status) VALUES ($1,'confirmed')", [slots[0].slot_id]);
  await client.query("UPDATE bm_property_inspection_slots SET status='cancelled' WHERE slot_id=$1", [slots[1].slot_id]);
  const before = (await client.query("SELECT * FROM bm_property_inspection_slots ORDER BY slot_id")).rows;
  const available = await listInspectionSlots(companyId, propertyId, new Date().toISOString(), new Date(Date.now()+14*86400000).toISOString());
  expect(available.some(slot => [slots[0].slot_id, slots[1].slot_id].includes(slot.slotId))).toBe(false);
  expect((await client.query("SELECT * FROM bm_property_inspection_slots ORDER BY slot_id")).rows).toEqual(before);
});
integration("does not generate availability for other companies or real agency properties", async () => {
  expect(await refreshDemoInspectionSlots(client, companyId, DEMO_PROPERTY_IDS[2])).toBe(0);
  expect(await refreshDemoInspectionSlots(client, "90000000-0000-4000-8000-000000000002", DEMO_PROPERTY_IDS[1])).toBe(0);
  expect(await refreshDemoInspectionSlots(client, companyId, "90000000-0000-4000-8000-000000000009")).toBe(0);
});
