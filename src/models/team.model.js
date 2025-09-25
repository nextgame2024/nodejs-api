import pool from "../config/db.js";

export async function getTeams() {
  const { rows } = await pool.query(
    `SELECT * FROM teams ORDER BY display_order ASC, created_at ASC`
  );
  return rows;
}

export async function getNextTeamOrder() {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(display_order),0)+1 AS n FROM teams`
  );
  return Number(rows[0].n) || 1;
}

export async function insertTeam({ name, displayOrder = 0 }) {
  const { rows } = await pool.query(
    `INSERT INTO teams (name, display_order)
     VALUES ($1, $2)
     RETURNING *`,
    [name, displayOrder]
  );
  return rows[0];
}

export async function updateTeamById(id, { name }) {
  if (name === undefined) {
    const { rows } = await pool.query(`SELECT * FROM teams WHERE id = $1`, [
      id,
    ]);
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `UPDATE teams SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [name, id]
  );
  return rows[0] || null;
}

export async function deleteTeamById(id) {
  const { rowCount } = await pool.query(`DELETE FROM teams WHERE id = $1`, [
    id,
  ]);
  return rowCount > 0;
}

export async function setTeamsOrder(ids) {
  const values = ids.map((_, i) => `($${i + 1}::uuid, ${i + 1})`).join(",");
  const sql = `
    WITH new_order(id, rank) AS (VALUES ${values})
    UPDATE teams t
       SET display_order = n.rank, updated_at = NOW()
      FROM new_order n
     WHERE t.id = n.id
  `;
  await pool.query(sql, ids);
}

/** MEMBERS */
export async function getMembersByTeam(teamId) {
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.email, e.phone, e.address, e.company, e.created_at, e.display_order
       FROM team_employees te
       JOIN employees e ON e.id = te.employee_id
      WHERE te.team_id = $1
      ORDER BY e.display_order, e.created_at`,
    [teamId]
  );
  return rows;
}

/** Replace all members atomically */
export async function replaceMembers(teamId, employeeIds) {
  await pool.query("BEGIN");
  try {
    await pool.query(`DELETE FROM team_employees WHERE team_id = $1`, [teamId]);

    if (employeeIds.length) {
      const values = employeeIds
        .map((_, i) => `($1, $${i + 2}::uuid)`)
        .join(",");
      await pool.query(
        `INSERT INTO team_employees(team_id, employee_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [teamId, ...employeeIds]
      );
    }

    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}
