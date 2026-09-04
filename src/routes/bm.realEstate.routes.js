import { Router } from "express";
import { businessManagerIntegrationAuth } from "../middlewares/bmIntegrationAuth.js";
import * as controller from "../controllers/bm.realEstate.controller.js";

const router = Router();
router.get("/bm/real-estate/properties", businessManagerIntegrationAuth, controller.searchProperties);
router.get("/bm/real-estate/properties/:propertyId", businessManagerIntegrationAuth, controller.getProperty);
router.get("/bm/real-estate/properties/:propertyId/inspection-slots", businessManagerIntegrationAuth, controller.listInspectionSlots);
router.post("/bm/real-estate/inspection-bookings", businessManagerIntegrationAuth, controller.createInspectionBooking);
router.get("/bm/real-estate/knowledge", businessManagerIntegrationAuth, controller.searchKnowledge);
export default router;
