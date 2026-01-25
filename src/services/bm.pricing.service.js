import * as model from "../models/bm.pricing.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export async function listPricingProfiles(userId, { q, status, page, limit }) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [pricingProfiles, total] = await Promise.all([
    model.listPricingProfiles(userId, { q, status, limit: safeLimit, offset }),
    model.countPricingProfiles(userId, { q, status }),
  ]);

  return { pricingProfiles, page: safePage, limit: safeLimit, total };
}

export const getPricingProfile = (userId, pricingProfileId) =>
  model.getPricingProfile(userId, pricingProfileId);

export const createPricingProfile = (userId, payload) =>
  model.createPricingProfile(userId, payload);

export const updatePricingProfile = (userId, pricingProfileId, payload) =>
  model.updatePricingProfile(userId, pricingProfileId, payload);

export const archivePricingProfile = (userId, pricingProfileId) =>
  model.archivePricingProfile(userId, pricingProfileId);

export async function setDefaultPricingProfile(userId, pricingProfileId) {
  // enforce single default per user
  await model.clearDefaultPricingProfiles(userId);
  return model.setDefaultPricingProfile(userId, pricingProfileId);
}
