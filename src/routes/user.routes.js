import { Router } from "express";
import {
  registerUser,
  getCurrentUser,
  getRuntimeIdentity,
  updateCurrentUser,
  listUsers,
  updateUserByAdmin,
  removeUserByAdmin,
  unsubscribeFromEmails,
} from "../controllers/user.controller.js";
import { authRequired } from "../middlewares/authJwt.js";
import { authOptional } from "../middlewares/authOptional.js";
import { activateTotp, disableTotp, enrolTotp, getMfaStatus, stepUpTotp } from "../controllers/mfa.controller.js";

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

// Lean, server-to-server identity projection for Sophia Runtime. The shared
// auth middleware remains the authority for session, company and MFA checks.
router.get("/user/runtime-identity", authRequired, getRuntimeIdentity);

// Update current user (auth)
router.put("/user", authRequired, updateCurrentUser);

// Current-user TOTP enrollment and recent-MFA step-up.
router.get("/user/mfa", authRequired, getMfaStatus);
router.post("/user/mfa/totp/enrol", authRequired, enrolTotp);
router.post("/user/mfa/totp/activate", authRequired, activateTotp);
router.post("/user/mfa/totp/disable", authRequired, disableTotp);
router.post("/user/mfa/totp/step-up", authRequired, stepUpTotp);

export default router;
