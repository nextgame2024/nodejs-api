import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listLabor,
  getLabor,
  createLabor,
  updateLabor,
  removeLabor,
  getDailyRate,
  updateDailyRate,
} from "../controllers/bm.labor.controller.js";

const router = Router();

router.get("/bm/labor", authRequired, listLabor);
router.post("/bm/labor", authRequired, createLabor);
router.get("/bm/labor/daily-rate", authRequired, getDailyRate);
router.put("/bm/labor/daily-rate", authRequired, updateDailyRate);
router.get("/bm/labor/:laborId", authRequired, getLabor);
router.put("/bm/labor/:laborId", authRequired, updateLabor);
router.delete("/bm/labor/:laborId", authRequired, removeLabor);

export default router;
