import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  getBusinessPackEntitlement,
  setBusinessPackEntitlement,
} from "../controllers/bm.business.pack.entitlements.controller.js";

const router = Router();

router.get("/bm/business-pack-entitlements", authRequired, getBusinessPackEntitlement);
router.put(
  "/bm/business-pack-entitlements/:userId",
  authRequired,
  setBusinessPackEntitlement,
);

export default router;
