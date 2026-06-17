import * as modelNS from "../models/bm.sites.model.js";

const model = modelNS.default ?? modelNS;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listSites(companyId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;
  const [sites, total] = await Promise.all([
    model.listSites(companyId, { q, status, limit: safeLimit, offset }),
    model.countSites(companyId, { q, status }),
  ]);
  return { sites, page: safePage, limit: safeLimit, total };
}

export const getSite = (companyId, siteId) => model.getSite(companyId, siteId);
export const createSite = (companyId, userId, payload) =>
  model.createSite(companyId, userId, payload);
export const updateSite = (companyId, siteId, payload) =>
  model.updateSite(companyId, siteId, payload);
export const archiveSite = (companyId, siteId) =>
  model.archiveSite(companyId, siteId);
