import { Router } from "express";
import { followProfile } from "../controllers/profile.controller.js";
import { authRequired } from "../middlewares/authJwt.js";

const router = Router();

router.post("/profiles/:username/follow", authRequired, followProfile);

export default router;
