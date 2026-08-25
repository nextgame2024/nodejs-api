import { Router } from "express";
import {
  login,
  requestPasswordReset,
  resetPassword,
} from "../controllers/auth.controller.js";

const router = Router();

router.post("/users/login", login);
router.post("/users/password/forgot", requestPasswordReset);
router.post("/users/password/reset", resetPassword);

export default router;
