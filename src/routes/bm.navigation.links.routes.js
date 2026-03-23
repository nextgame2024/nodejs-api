import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  listNavigationLinks,
  getNavigationLink,
  createNavigationLink,
  updateNavigationLink,
  deleteNavigationLink,
  listActiveNavigationLinks,
} from "../controllers/bm.navigation.links.controller.js";

const router = Router();

router.get("/bm/navigation-links/active", authRequired, listActiveNavigationLinks);

router.get("/bm/navigation-links", authRequired, listNavigationLinks);
router.post("/bm/navigation-links", authRequired, createNavigationLink);
router.get("/bm/navigation-links/:navigationLinkId", authRequired, getNavigationLink);
router.put("/bm/navigation-links/:navigationLinkId", authRequired, updateNavigationLink);
router.delete(
  "/bm/navigation-links/:navigationLinkId",
  authRequired,
  deleteNavigationLink,
);

export default router;
