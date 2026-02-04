import * as model from "../models/bm.company.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listCompanies(companyId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [companies, total] = await Promise.all([
    model.listCompanies(companyId, { q, status, limit: safeLimit, offset }),
    model.countCompanies(companyId, { q, status }),
  ]);

  return { companies, page: safePage, limit: safeLimit, total };
}

export const getCompany = (companyId, targetCompanyId) =>
  model.getCompany(companyId, targetCompanyId);
export const createCompany = (companyId, userId, payload) =>
  model.createCompany(companyId, userId, payload);
export const updateCompany = (companyId, targetCompanyId, payload) =>
  model.updateCompany(companyId, targetCompanyId, payload);
export const archiveCompany = (companyId, targetCompanyId) =>
  model.archiveCompany(companyId, targetCompanyId);
