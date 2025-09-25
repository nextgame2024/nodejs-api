import pool from "../config/db.js";

export async function getEmployees() {
  const { rows } = await pool.query(
    `SELECT id, name, phone, email, address, company, created_at, display_order
       FROM employees
      ORDER BY display_order ASC, created_at ASC`
  );
  return rows;
}
