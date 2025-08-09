import { Router } from "express";
import { login } from "../controllers/auth.controller.js";

const router = Router();

router.post("/users/login", login);

export default router;
