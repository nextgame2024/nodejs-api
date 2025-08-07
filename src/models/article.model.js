import pool from "../config/db.js";

export async function getAllArticles() {
  const [rows] = await pool.query(
    `SELECT a.*, u.username, u.image, u.bio
       FROM articles a
       JOIN users u ON u.id = a.author_id
       ORDER BY a.createdAt DESC`
  );
  return rows;
}
