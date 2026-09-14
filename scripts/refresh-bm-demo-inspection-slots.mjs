import "dotenv/config";
import pool from "../src/config/db.js";
import { DEMO_PROPERTY_IDS, refreshDemoInspectionSlots } from "../src/models/bm.demoInspectionSlots.model.js";

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT company_id, property_id, listing_type FROM bm_properties
     WHERE property_id = ANY($1::uuid[]) AND agent_email = 'alex.morgan@example.com'
       AND status = 'available' ORDER BY property_id`,
    [DEMO_PROPERTY_IDS],
  );
  const added = { rent: 0, sale: 0 };
  for (const property of rows) {
    added[property.listing_type] += await refreshDemoInspectionSlots(
      client, property.company_id, property.property_id,
    );
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ properties: rows.length, slotsAdded: added }));
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
