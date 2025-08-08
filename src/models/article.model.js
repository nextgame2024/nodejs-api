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

export async function getFeedArticles({ userId, limit = 20, offset = 0 }) {
  const [rows] = await pool.query(
    `
      SELECT
        a.id, a.slug, a.title, a.description, a.body,
        a.createdAt, a.updatedAt,
        u.username, u.image, u.bio,
        COALESCE(COUNT(fav.user_id), 0) AS favoritesCount,
        /* true if current user has favorited */
        COALESCE(MAX(fav.user_id = ?), 0) AS favorited
      FROM follows f
      JOIN articles a     ON a.author_id = f.followee_id
      JOIN users    u     ON u.id        = a.author_id
      LEFT JOIN article_favorites fav ON fav.article_id = a.id
      WHERE f.follower_id = ?
      GROUP BY a.id
      ORDER BY a.createdAt DESC
      LIMIT ? OFFSET ?;
      `,
    [userId, userId, Number(limit), Number(offset)]
  );

  return rows;
}
