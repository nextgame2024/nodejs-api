import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.realEstate.service.js";

export const searchProperties = asyncHandler(async (req, res) => res.json({ properties: await service.searchProperties(req.user.companyId, req.query) }));
export const getProperty = asyncHandler(async (req, res) => {
  const property = await service.getProperty(req.user.companyId, req.params.propertyId);
  if (!property) return res.status(404).json({ error: "Property not found" });
  res.json({ property });
});
export const listInspectionSlots = asyncHandler(async (req, res) => res.json({ slots: await service.listInspectionSlots(req.user.companyId, req.params.propertyId, req.query) }));
export const createInspectionBooking = asyncHandler(async (req, res) => res.status(201).json({ booking: await service.createInspectionBooking(req.user.companyId, req.body?.booking ?? req.body) }));
export const searchKnowledge = asyncHandler(async (req, res) => res.json({ results: await service.searchKnowledge(req.user.companyId, req.query) }));
