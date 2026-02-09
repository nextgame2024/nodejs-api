import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.pricing.service.js";

export const listPricingProfiles = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, status, page = "1", limit = "20" } = req.query;

  const result = await service.listPricingProfiles(companyId, {
    q,
    status,
    page: Number(page),
    limit: Number(limit),
  });

  res.json(result);
});

export const getPricingProfile = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { pricingProfileId } = req.params;

  const pricingProfile = await service.getPricingProfile(
    companyId,
    pricingProfileId
  );
  if (!pricingProfile)
    return res.status(404).json({ error: "Pricing profile not found" });

  res.json({ pricingProfile });
});

export const createPricingProfile = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.pricingProfile || req.body || {};

  if (!payload.profile_name)
    return res.status(400).json({ error: "profile_name is required" });

  const pricingProfile = await service.createPricingProfile(
    companyId,
    userId,
    payload
  );

  res.status(201).json({ pricingProfile });
});

export const updatePricingProfile = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { pricingProfileId } = req.params;
  const payload = req.body?.pricingProfile || req.body || {};

  const pricingProfile = await service.updatePricingProfile(
    companyId,
    pricingProfileId,
    payload
  );
  if (!pricingProfile)
    return res.status(404).json({ error: "Pricing profile not found" });

  res.json({ pricingProfile });
});

export const archivePricingProfile = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { pricingProfileId } = req.params;

  const result = await service.removePricingProfile(companyId, pricingProfileId);
  if (!result) return res.status(404).json({ error: "Pricing profile not found" });

  res.json({ pricingProfileId, action: result.action });
});
