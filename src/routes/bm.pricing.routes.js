import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listPricingProfiles,
  getPricingProfile,
  createPricingProfile,
  updatePricingProfile,
  archivePricingProfile,
  setDefaultPricingProfile,
} from "../controllers/bm.pricing.controller.js";

const router = Router();

router.get("/bm/pricing-profiles", authRequired, listPricingProfiles);
router.post("/bm/pricing-profiles", authRequired, createPricingProfile);
router.get(
  "/bm/pricing-profiles/:pricingProfileId",
  authRequired,
  getPricingProfile
);
router.put(
  "/bm/pricing-profiles/:pricingProfileId",
  authRequired,
  updatePricingProfile
);
router.delete(
  "/bm/pricing-profiles/:pricingProfileId",
  authRequired,
  archivePricingProfile
);

// optional helper endpoint
router.post(
  "/bm/pricing-profiles/:pricingProfileId/set-default",
  authRequired,
  setDefaultPricingProfile
);

export default router;
