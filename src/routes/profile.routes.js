import { Router } from "express";
import { authOptional } from "../middlewares/authOptional.js";
import { getProfile } from "../controllers/profile.controller.js";

const router = Router();

router.get("/profiles/:username", authOptional, getProfile);

export default router;
