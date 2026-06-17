import * as modelNS from "../models/bm.pallets.model.js";

const model = modelNS.default ?? modelNS;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function pageArgs(page, limit) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  return { safePage, safeLimit, offset: (safePage - 1) * safeLimit };
}

export async function getContext(companyId, userId) {
  const originSite = await model.getCurrentUserSite(companyId, userId);
  const destinationSites = originSite
    ? await model.listDestinations(companyId, originSite.siteId)
    : [];
  return { originSite, destinationSites };
}

export async function listOnSite(companyId, { q, page, limit }) {
  const { safePage, safeLimit, offset } = pageArgs(page, limit);
  const [sites, total] = await Promise.all([
    model.listOnSite(companyId, { q, limit: safeLimit, offset }),
    model.countOnSite(companyId, { q }),
  ]);
  return { sites, page: safePage, limit: safeLimit, total };
}

export async function listSent(companyId, userId, { page, limit }) {
  const originSite = await model.getCurrentUserSite(companyId, userId);
  if (!originSite) return { originSite: null, movements: [], page: 1, limit: Number(limit) || 20, total: 0 };
  const { safePage, safeLimit, offset } = pageArgs(page, limit);
  const [movements, total] = await Promise.all([
    model.listSent(companyId, originSite.siteId, { limit: safeLimit, offset }),
    model.countSent(companyId, originSite.siteId),
  ]);
  return { originSite, movements, page: safePage, limit: safeLimit, total };
}

export async function listIncoming(companyId, userId, { page, limit }) {
  const destinationSite = await model.getCurrentUserSite(companyId, userId);
  if (!destinationSite) return { destinationSite: null, movements: [], page: 1, limit: Number(limit) || 20, total: 0 };
  const { safePage, safeLimit, offset } = pageArgs(page, limit);
  const [movements, total] = await Promise.all([
    model.listIncoming(companyId, destinationSite.siteId, {
      limit: safeLimit,
      offset,
    }),
    model.countIncoming(companyId, destinationSite.siteId),
  ]);
  return { destinationSite, movements, page: safePage, limit: safeLimit, total };
}

export const movePallets = (companyId, userId, payload) =>
  model.movePallets(companyId, userId, payload);
export const deleteMovement = (companyId, userId, palletId) =>
  model.deleteMovement(companyId, userId, palletId);
export const receiveMovement = (companyId, userId, palletId) =>
  model.receiveMovement(companyId, userId, palletId);
