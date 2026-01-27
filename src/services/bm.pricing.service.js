import * as model from "../models/bm.pricing.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listPricingProfiles(
  companyId,
  { q, status, page, limit }
) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [pricingProfiles, total] = await Promise.all([
    model.listPricingProfiles(companyId, {
      q,
      status,
      limit: safeLimit,
      offset,
    }),
    model.countPricingProfiles(companyId, { q, status }),
  ]);

  return { pricingProfiles, page: safePage, limit: safeLimit, total };
}

export const getPricingProfile = (companyId, pricingProfileId) =>
  model.getPricingProfile(companyId, pricingProfileId);

export const createPricingProfile = (companyId, userId, payload) =>
  model.createPricingProfile(companyId, userId, payload);

export const updatePricingProfile = (companyId, pricingProfileId, payload) =>
  model.updatePricingProfile(companyId, pricingProfileId, payload);

export const archivePricingProfile = (companyId, pricingProfileId) =>
  model.archivePricingProfile(companyId, pricingProfileId);

export const clearDefaultPricingProfiles = (companyId) =>
  model.clearDefaultPricingProfiles(companyId);

export const setDefaultPricingProfile = (companyId, pricingProfileId) =>
  model.setDefaultPricingProfile(companyId, pricingProfileId);
