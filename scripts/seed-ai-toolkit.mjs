import "dotenv/config";
import pool from "../src/config/db.js";
import { ensureToolkitSeeded } from "../src/models/bm.toolkit.model.js";

try {
  await ensureToolkitSeeded({ requireSeedData: true });
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM toolkit_courses) AS courses,
      (SELECT COUNT(*)::int FROM toolkit_categories) AS categories,
      (SELECT COUNT(*)::int FROM toolkit_recipes) AS recipes,
      (SELECT COUNT(*)::int FROM toolkit_quick_actions) AS quick_actions
  `);
  console.log("AI Toolkit seed complete:", rows[0]);
} catch (err) {
  console.error("AI Toolkit seed failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
