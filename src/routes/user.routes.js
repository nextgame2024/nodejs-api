import { Router } from "express";
import {
  registerUser,
  getCurrentUser,
  updateCurrentUser,
  listUsers,
  updateUserByAdmin,
  removeUserByAdmin,
  unsubscribeFromEmails,
} from "../controllers/user.controller.js";
import { authRequired } from "../middlewares/authJwt.js";
import { authOptional } from "../middlewares/authOptional.js";

const router = Router();

// Register (no auth) or admin create (optional auth to set company_id)
router.post("/users", authOptional, registerUser);

// Public one-click email opt-out
router.get("/emails/unsubscribe", unsubscribeFromEmails);

// Users list (auth, company scoped)
router.get("/users", authRequired, listUsers);

// Update any user (auth, company scoped)
router.put("/users/:id", authRequired, updateUserByAdmin);
router.delete("/users/:id", authRequired, removeUserByAdmin);

// Current user (auth)
router.get("/user", authRequired, getCurrentUser);

// Update current user (auth)
router.put("/user", authRequired, updateCurrentUser);

export default router;
