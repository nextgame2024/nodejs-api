import { Router } from "express";
import {
  registerUser,
  getCurrentUser,
  updateCurrentUser,
  listUsers,
  updateUserByAdmin,
} from "../controllers/user.controller.js";
import { authRequired } from "../middlewares/authJwt.js";

const router = Router();

// Register (no auth)
router.post("/users", registerUser);

// Users list (auth, company scoped)
router.get("/users", authRequired, listUsers);

// Update any user (auth, company scoped)
router.put("/users/:id", authRequired, updateUserByAdmin);

// Current user (auth)
router.get("/user", authRequired, getCurrentUser);

// Update current user (auth)
router.put("/user", authRequired, updateCurrentUser);

export default router;
