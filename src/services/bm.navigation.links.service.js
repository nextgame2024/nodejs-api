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

export async function listActiveNavigationLinks(
  companyId,
  userId,
  { navigationType },
) {
  const navigationLinks = await model.listActiveNavigationLinks(companyId, {
    navigationType,
  });
  const includeSophiaAdmin =
    (!navigationType || navigationType === "header") &&
    (await model.hasActiveSophiaAdminEntitlement(companyId, userId));
  if (!includeSophiaAdmin) return navigationLinks;
  return [
    ...navigationLinks,
    {
      navigationLinkId: `sophia-admin:${userId}`,
      companyId,
      userId,
      navigationType: "header",
      navigationLabel: "Sophia Ai admin",
      active: true,
      createdAt: null,
      updatedAt: null,
    },
  ];
}

export const getSophiaAdminEntitlement = (companyId, targetUserId) =>
  model.getSophiaAdminEntitlement(companyId, targetUserId);

export const syncSophiaAdminEntitlement = (args) =>
  model.syncSophiaAdminEntitlement(args);

export const companyExists = (companyId) => model.companyExists(companyId);

const normalizeLabel = (value) => String(value || "").trim().toLowerCase();

export async function syncNavigationLabels(
  companyId,
  userId,
  { navigation_type, navigation_labels },
) {
  const desiredLabels = Array.from(
    new Set((navigation_labels || []).map((label) => String(label).trim())),
  ).filter(Boolean);

  const desiredByNorm = new Map(
    desiredLabels.map((label) => [normalizeLabel(label), label]),
  );

  const existing = await model.listNavigationLinksByCompanyAndType(
    companyId,
    navigation_type,
  );
  const existingByNorm = new Map(
    existing.map((row) => [normalizeLabel(row.navigationLabel), row]),
  );

  const toCreate = desiredLabels.filter(
    (label) => !existingByNorm.has(normalizeLabel(label)),
  );
  const toDelete = existing.filter(
    (row) => !desiredByNorm.has(normalizeLabel(row.navigationLabel)),
  );

  for (const label of toCreate) {
    await model.createNavigationLink(companyId, userId, {
      navigation_type,
      navigation_label: label,
      active: true,
    });
  }

  for (const row of toDelete) {
    await model.deleteNavigationLink(companyId, row.navigationLinkId);
  }

  const navigationLinks = await model.listNavigationLinksByCompanyAndType(
    companyId,
    navigation_type,
  );

  return {
    navigationLinks,
    createdLabels: toCreate,
    removedLabels: toDelete.map((row) => row.navigationLabel),
  };
}
