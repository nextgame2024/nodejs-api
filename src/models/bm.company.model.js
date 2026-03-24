import pool from "../config/db.js";

const COMPANY_SELECT = `
  company_id AS "companyId",
  owner_user_id AS "ownerUserId",
  company_name AS "companyName",
  status,
  createdat AS "createdAt",
  updatedat AS "updatedAt",
  legal_name AS "legalName",
  trading_name AS "tradingName",
  abn,
  address,
  email,
  phone,
  tel,
  website,
  cel,
  bank,
  account_name AS "accountName",
  bsb_number AS "bsbNumber",
  account_number AS "accountNumber",
  logo_url AS "logoUrl"
`;

export async function listCompanies(companyId, { q, status, limit, offset }) {
  const params = [];
  let i = 1;
  const where = [];

  if (companyId) {
    where.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(
      `(company_name ILIKE $${i} OR legal_name ILIKE $${i} OR trading_name ILIKE $${i} OR abn ILIKE $${i} OR email ILIKE $${i} OR address ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT ${COMPANY_SELECT}
    FROM bm_company
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY company_name ASC NULLS LAST, createdat DESC
    LIMIT $${i++} OFFSET $${i}
    `,
    params,
  );

  return rows;
}

export async function countCompanies(companyId, { q, status }) {
  const params = [];
  let i = 1;
  const where = [];

  if (companyId) {
    where.push(`company_id = $${i++}`);
    params.push(companyId);
  }

  if (status) {
    where.push(`status = $${i++}`);
    params.push(status);
  }
  if (q) {
    where.push(
      `(company_name ILIKE $${i} OR legal_name ILIKE $${i} OR trading_name ILIKE $${i} OR abn ILIKE $${i} OR email ILIKE $${i} OR address ILIKE $${i})`,
    );
    params.push(`%${q}%`);
    i++;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM bm_company ${whereSql}`,
    params,
  );
  return rows[0]?.total ?? 0;
}

export async function getCompany(companyId, targetCompanyId) {
  const { rows } = await pool.query(
    `SELECT ${COMPANY_SELECT}
     FROM bm_company
     WHERE company_id = $1 AND company_id = $2
     LIMIT 1`,
    [companyId, targetCompanyId],
  );
  return rows[0];
}

export async function createCompany(companyId, userId, payload) {
  const { rows } = await pool.query(
    `INSERT INTO bm_company (
        company_id,
        owner_user_id,
        company_name,
        status,
        legal_name,
        trading_name,
        abn,
        address,
        email,
        phone,
        tel,
        website,
        cel,
        bank,
        account_name,
        bsb_number,
        account_number,
        logo_url
     ) VALUES (
        COALESCE($1::uuid, gen_random_uuid()),
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
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18
     )
     RETURNING ${COMPANY_SELECT}`,
    [
      companyId,
      payload.owner_user_id ?? userId,
      payload.company_name,
      payload.status ?? "active",
      payload.legal_name ?? null,
      payload.trading_name ?? null,
      payload.abn ?? null,
      payload.address ?? null,
      payload.email ?? null,
      payload.phone ?? null,
      payload.tel ?? null,
      payload.website ?? null,
      payload.cel ?? null,
      payload.bank ?? null,
      payload.account_name ?? null,
      payload.bsb_number ?? null,
      payload.account_number ?? null,
      payload.logo_url ?? null,
    ],
  );
  return rows[0];
}

export async function updateCompany(companyId, targetCompanyId, payload) {
  const sets = [];
  const params = [companyId, targetCompanyId];
  let i = 3;

  const map = {
    company_name: "company_name",
    status: "status",
    legal_name: "legal_name",
    trading_name: "trading_name",
    abn: "abn",
    address: "address",
    email: "email",
    phone: "phone",
    tel: "tel",
    website: "website",
    cel: "cel",
    bank: "bank",
    account_name: "account_name",
    bsb_number: "bsb_number",
    account_number: "account_number",
    logo_url: "logo_url",
  };

  for (const [k, col] of Object.entries(map)) {
    if (payload[k] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(payload[k]);
    }
  }

  if (!sets.length) return getCompany(companyId, targetCompanyId);
  sets.push(`updatedat = NOW()`);

  const { rows } = await pool.query(
    `UPDATE bm_company
     SET ${sets.join(", ")}
     WHERE company_id = $1 AND company_id = $2
     RETURNING ${COMPANY_SELECT}`,
    params,
  );
  return rows[0];
}

export async function archiveCompany(companyId, targetCompanyId) {
  const res = await pool.query(
    `UPDATE bm_company
     SET status = 'archived', updatedat = NOW()
     WHERE company_id = $1 AND company_id = $2`,
    [companyId, targetCompanyId],
  );
  return res.rowCount > 0;
}
