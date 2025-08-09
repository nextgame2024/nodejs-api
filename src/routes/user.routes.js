import { Router } from "express";
import {
  registerUser,
  getCurrentUser,
  updateCurrentUser,
} from "../controllers/user.controller.js";
import { authRequired } from "../middlewares/authJwt.js";

const router = Router();

// Register (no auth)
router.post("/users", registerUser);

// Current user (auth)
router.get("/user", authRequired, getCurrentUser);

// Update current user (auth)
router.put("/user", authRequired, updateCurrentUser);

export default router;
