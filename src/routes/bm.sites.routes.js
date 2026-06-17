import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  archiveSite,
  createSite,
  getSite,
  listSites,
  updateSite,
} from "../controllers/bm.sites.controller.js";

const router = Router();

router.get("/bm/sites", authRequired, listSites);
router.post("/bm/sites", authRequired, createSite);
router.get("/bm/sites/:siteId", authRequired, getSite);
router.put("/bm/sites/:siteId", authRequired, updateSite);
router.delete("/bm/sites/:siteId", authRequired, archiveSite);

export default router;
