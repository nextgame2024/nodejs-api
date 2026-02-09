import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listMaterials,
  getMaterial,
  createMaterial,
  updateMaterial,
  removeMaterial,
} from "../controllers/bm.materials.controller.js";

const router = Router();

router.get("/bm/materials", authRequired, listMaterials);
router.post("/bm/materials", authRequired, createMaterial);
router.get("/bm/materials/:materialId", authRequired, getMaterial);
router.put("/bm/materials/:materialId", authRequired, updateMaterial);
router.delete("/bm/materials/:materialId", authRequired, removeMaterial);

export default router;
