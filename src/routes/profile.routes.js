import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import { authOptional } from "../middlewares/authOptional.js";
import {
  getProfile,
  followProfile,
  unfollowProfile,
} from "../controllers/profile.controller.js";

const router = Router();

router.get("/profiles/:username", authOptional, getProfile);
router.post("/profiles/:username/follow", authRequired, followProfile);
router.delete("/profiles/:username/follow", authRequired, unfollowProfile);

export default router;
