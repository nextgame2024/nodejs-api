import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listLabor,
  getLabor,
  createLabor,
  updateLabor,
  removeLabor,
} from "../controllers/bm.labor.controller.js";

const router = Router();

router.get("/bm/labor", authRequired, listLabor);
router.post("/bm/labor", authRequired, createLabor);
router.get("/bm/labor/:laborId", authRequired, getLabor);
router.put("/bm/labor/:laborId", authRequired, updateLabor);
router.delete("/bm/labor/:laborId", authRequired, removeLabor);

export default router;
