import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  createSchedule,
  listScheduleItems,
  listSchedules,
  updateSchedule,
} from "../controllers/bm.schedule.controller.js";

const router = Router();

router.get("/bm/schedule", authRequired, listSchedules);
router.get("/bm/schedule/items", authRequired, listScheduleItems);
router.post("/bm/schedule", authRequired, createSchedule);
router.put("/bm/schedule/:scheduleId", authRequired, updateSchedule);

export default router;
