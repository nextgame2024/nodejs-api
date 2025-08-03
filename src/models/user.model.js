import pool from "../config/db.js";

export async function findByEmail(email) {
  const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [
    email,
  ]);
  return rows[0];
}
