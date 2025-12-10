import pgPkg from "pg";
import { asyncHandler } from "../middlewares/asyncHandler.js";

const { Pool } = pgPkg;

const connectionString =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST &&
    `postgres://${encodeURIComponent(
      process.env.DB_USER
    )}:${encodeURIComponent(process.env.DB_PASSWORD)}@${
      process.env.DB_HOST
    }:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE}`);

if (!connectionString) {
  console.warn(
    "[plannerProjects] No DATABASE_URL/DB_* configured – planner DB features will fail"
  );
}

const pool = connectionString ? new Pool({ connectionString }) : null;

/**
 * GET /api/planner/projects
 * List projects for the authenticated user.
 */
export const listProjectsHandler = asyncHandler(async (req, res) => {
  if (!pool) {
    throw new Error("Planner DB is not configured");
  }

  const userId = (req.user && req.user.id) || null;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  const result = await pool.query(
    `SELECT
       id,
       title,
       address,
       lot_plan,
       status,
       dev_type,
       assessment_level,
       created_at,
       updated_at
     FROM planner_projects
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return res.json({ projects: result.rows });
});

/**
 * GET /api/planner/projects/:id
 * Get a single project (with full JSON fields).
 */
export const getProjectHandler = asyncHandler(async (req, res) => {
  if (!pool) {
    throw new Error("Planner DB is not configured");
  }

  const userId = (req.user && req.user.id) || null;
  const id = req.params.id;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  const result = await pool.query(
    `SELECT *
       FROM planner_projects
      WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Project not found" });
  }

  return res.json({ project: result.rows[0] });
});
