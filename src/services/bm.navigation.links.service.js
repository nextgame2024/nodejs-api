import * as modelNS from "../models/bm.navigation.links.model.js";

const model = modelNS.default ?? modelNS;
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listNavigationLinks(
  companyId,
  { q, navigationType, active, page, limit },
) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [navigationLinks, total] = await Promise.all([
    model.listNavigationLinks(companyId, {
      q,
      navigationType,
      active,
      limit: safeLimit,
      offset,
    }),
    model.countNavigationLinks(companyId, { q, navigationType, active }),
  ]);

  return { navigationLinks, page: safePage, limit: safeLimit, total };
}

export const getNavigationLink = (companyId, navigationLinkId) =>
  model.getNavigationLink(companyId, navigationLinkId);

export const createNavigationLink = (companyId, userId, payload) =>
  model.createNavigationLink(companyId, userId, payload);

export const updateNavigationLink = (companyId, navigationLinkId, payload) =>
  model.updateNavigationLink(companyId, navigationLinkId, payload);

export const deleteNavigationLink = (companyId, navigationLinkId) =>
  model.deleteNavigationLink(companyId, navigationLinkId);

export const listActiveNavigationLinks = (companyId, { navigationType }) =>
  model.listActiveNavigationLinks(companyId, { navigationType });

export const companyExists = (companyId) => model.companyExists(companyId);
