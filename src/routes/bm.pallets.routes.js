import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  deleteMovement,
  getContext,
  listIncoming,
  listOnSite,
  listSent,
  movePallets,
  receiveMovement,
} from "../controllers/bm.pallets.controller.js";

const router = Router();

router.get("/bm/pallets/context", authRequired, getContext);
router.get("/bm/pallets/on-site", authRequired, listOnSite);
router.get("/bm/pallets/sent", authRequired, listSent);
router.get("/bm/pallets/incoming", authRequired, listIncoming);
router.post("/bm/pallets/move", authRequired, movePallets);
router.delete("/bm/pallets/:palletId", authRequired, deleteMovement);
router.post("/bm/pallets/:palletId/receive", authRequired, receiveMovement);

export default router;
