import pool from "../config/db.js";

const SCHEDULE_SELECT = `
  s.schedule_id AS "scheduleId",
  s.company_id AS "companyId",
  s.user_id AS "userId",
  s.project_id AS "projectId",
  s.scheduled_item_type AS "scheduledItemType",
  s.scheduled_item_id AS "scheduledItemId",
  COALESCE(p.project_name, s.scheduled_item_label) AS "scheduledItemLabel",
  COALESCE(c.client_name, s.scheduled_item_secondary_label) AS "scheduledItemSecondaryLabel",
  TO_CHAR(s.schedule_date, 'YYYY-MM-DD') AS "date",
  TO_CHAR(s.start_time, 'HH24:MI') AS "startTime",
  TO_CHAR(s.end_time, 'HH24:MI') AS "endTime",
  s.description,
  s.createdat AS "createdAt",
  s.updatedat AS "updatedAt"
`;

export async function listSchedules(companyId, { start, end, projectId }) {
  const { rows } = await pool.query(
    `
    SELECT ${SCHEDULE_SELECT}
    FROM bm_schedule s
    LEFT JOIN bm_projects p
      ON p.company_id = s.company_id
     AND p.project_id = s.project_id
    LEFT JOIN bm_clients c
      ON c.company_id = s.company_id
     AND c.client_id = p.client_id
    WHERE s.company_id = $1
      AND s.schedule_date BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR s.project_id = $4)
    ORDER BY s.schedule_date ASC, s.start_time ASC, s.createdat ASC
    `,
    [companyId, start, end, projectId ?? null],
  );

  return rows;
}

export async function getSchedule(companyId, scheduleId) {
  const { rows } = await pool.query(
    `
    SELECT ${SCHEDULE_SELECT}
    FROM bm_schedule s
    LEFT JOIN bm_projects p
      ON p.company_id = s.company_id
     AND p.project_id = s.project_id
    LEFT JOIN bm_clients c
      ON c.company_id = s.company_id
     AND c.client_id = p.client_id
    WHERE s.company_id = $1
      AND s.schedule_id = $2
    LIMIT 1
    `,
    [companyId, scheduleId],
  );

  return rows[0] ?? null;
}

export async function searchScheduledItems(companyId, { q, type, limit }) {
  if (type !== "project") {
    return [];
  }

  const params = [companyId];
  let index = 2;
  const where = [
    `p.company_id = $1`,
    `p.status::text <> 'deleted'`,
    `COALESCE(p.status::text, '') <> 'archived'`,
  ];

  if (q) {
    where.push(
      `(p.project_name ILIKE $${index} OR c.client_name ILIKE $${index})`,
    );
    params.push(`%${q}%`);
    index += 1;
  }

  params.push(limit);

  const { rows } = await pool.query(
    `
    SELECT
      p.project_id AS "scheduledItemId",
      'project' AS "scheduledItemType",
      p.project_id AS "projectId",
      p.project_name AS "scheduledItemLabel",
      c.client_name AS "scheduledItemSecondaryLabel"
    FROM bm_projects p
    JOIN bm_clients c
      ON c.company_id = p.company_id
     AND c.client_id = p.client_id
    WHERE ${where.join(" AND ")}
    ORDER BY
      LOWER(p.project_name) ASC NULLS LAST,
      LOWER(c.client_name) ASC NULLS LAST,
      p.createdat DESC
    LIMIT $${index}
    `,
    params,
  );

  return rows;
}

export async function createSchedule(companyId, userId, payload) {
  const { rows } = await pool.query(
    `
    INSERT INTO bm_schedule (
      schedule_id,
      company_id,
      user_id,
      project_id,
      scheduled_item_type,
      scheduled_item_id,
      scheduled_item_label,
      scheduled_item_secondary_label,
      schedule_date,
      start_time,
      end_time,
      description,
      updatedat
    ) VALUES (
      gen_random_uuid(),
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      NOW()
    )
    RETURNING schedule_id AS "scheduleId"
    `,
    [
      companyId,
      userId,
      payload.project_id ?? null,
      payload.scheduled_item_type,
      payload.scheduled_item_id,
      payload.scheduled_item_label,
      payload.scheduled_item_secondary_label ?? null,
      payload.date,
      payload.start_time,
      payload.end_time,
      payload.description,
    ],
  );

  return getSchedule(companyId, rows[0]?.scheduleId);
}

export async function updateSchedule(companyId, scheduleId, payload) {
  const { rows } = await pool.query(
    `
    UPDATE bm_schedule
    SET
      project_id = $3,
      scheduled_item_type = $4,
      scheduled_item_id = $5,
      scheduled_item_label = $6,
      scheduled_item_secondary_label = $7,
      schedule_date = $8,
      start_time = $9,
      end_time = $10,
      description = $11,
      updatedat = NOW()
    WHERE company_id = $1
      AND schedule_id = $2
    RETURNING schedule_id AS "scheduleId"
    `,
    [
      companyId,
      scheduleId,
      payload.project_id ?? null,
      payload.scheduled_item_type,
      payload.scheduled_item_id,
      payload.scheduled_item_label,
      payload.scheduled_item_secondary_label ?? null,
      payload.date,
      payload.start_time,
      payload.end_time,
      payload.description,
    ],
  );

  if (!rows[0]) {
    return null;
  }

  return getSchedule(companyId, rows[0].scheduleId);
}

export async function deleteSchedule(companyId, scheduleId) {
  const { rows } = await pool.query(
    `
    DELETE FROM bm_schedule
    WHERE company_id = $1
      AND schedule_id = $2
    RETURNING schedule_id AS "scheduleId"
    `,
    [companyId, scheduleId],
  );

  return rows[0] ?? null;
}
