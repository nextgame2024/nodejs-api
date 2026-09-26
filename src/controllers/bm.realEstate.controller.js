import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.realEstate.service.js";

export const connectorIdentity = asyncHandler(async (req, res) => res.json({
  externalAccountId: req.user.companyId,
}));

export const searchProperties = asyncHandler(async (req, res) => res.json({ properties: await service.searchProperties(req.user.companyId, req.query) }));
export const getProperty = asyncHandler(async (req, res) => {
  const property = await service.getProperty(req.user.companyId, req.params.propertyId);
  if (!property) return res.status(404).json({ error: "Property not found" });
  res.json({ property });
});
export const listInspectionSlots = asyncHandler(async (req, res) => res.json({ slots: await service.listInspectionSlots(req.user.companyId, req.params.propertyId, req.query) }));
export const getInspectionSlot = asyncHandler(async (req, res) => res.json({ slot: await service.getInspectionSlot(req.user.companyId, req.params.propertyId, req.params.slotId) }));
export const createInspectionBooking = asyncHandler(async (req, res) => res.status(201).json({ booking: await service.createInspectionBooking(req.user.companyId, req.body?.booking ?? req.body) }));
export const getInspectionBookingStatus = asyncHandler(async (req, res) => res.json({ operation: await service.getInspectionBookingStatus(req.user.companyId, req.params.bookingId) }));
export const reconcileInspectionBooking = asyncHandler(async (req, res) => res.json({ operation: await service.reconcileInspectionBooking(req.user.companyId, req.params.commandId) }));
export const getInspectionDeliveryStatus = asyncHandler(async (req, res) => res.json({ operation: await service.getInspectionDeliveryStatus(req.user.companyId, req.params.operationRef) }));
export const reconcileInspectionDelivery = asyncHandler(async (req, res) => res.json({ operation: await service.reconcileInspectionDelivery(req.user.companyId, req.params.commandId) }));
export const getPropertyWorkflowStatus = asyncHandler(async (req, res) => res.json({ operation: await service.getPropertyWorkflowStatus(req.user.companyId, req.params.workflowRef) }));
export const sendInspectionConfirmation = asyncHandler(async (req, res) => res.json({
  confirmationEmail: await service.sendInspectionConfirmation(
    req.user.companyId,
    req.params.bookingId,
    req.body,
  ),
}));
export const searchKnowledge = asyncHandler(async (req, res) => res.json({ results: await service.searchKnowledge(req.user.companyId, req.query) }));
export const getInspectionPrivacyData = asyncHandler(async (req, res) => res.json(
  await service.getInspectionPrivacyData(req.user.companyId, req.body),
));
export const redactInspectionPrivacyData = asyncHandler(async (req, res) => res.json(
  await service.redactInspectionPrivacyData(req.user.companyId, req.body),
));
