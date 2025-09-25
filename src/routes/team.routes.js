import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import { authOptional } from "../middlewares/authOptional.js";
import {
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  reorderTeams,
  getTeamMembers,
  setTeamMembers,
} from "../controllers/team.controller.js";

const router = Router();

router.get("/teams", authOptional, listTeams);
router.post("/teams", authRequired, createTeam);
router.put("/teams/:id", authRequired, updateTeam);
router.delete("/teams/:id", authRequired, deleteTeam);
router.patch("/teams/reorder", authRequired, reorderTeams);

/** members */
router.get("/teams/:id/members", authOptional, getTeamMembers);
router.put("/teams/:id/members", authRequired, setTeamMembers);

export default router;
