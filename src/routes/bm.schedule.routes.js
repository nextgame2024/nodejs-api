import * as appointments from "../services/scheduling/lead-appointments.service.js";
import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  createSchedule,
  deleteSchedule,
  listScheduleItems,
  listSchedules,
  updateSchedule,
} from "../controllers/bm.schedule.controller.js";

const router = Router();

const bookingHandler = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    const known = [400, 403, 404, 409, 503].includes(e.status);
    res.status(known ? e.status : 500).json({
      error: known
        ? e.message
        : "The appointment request could not be completed. Try again.",
      fields: known ? (e.fields ?? []) : [],
    });
  }
};
router.get(
  "/bm/schedule/leads/context",
  authRequired,
  bookingHandler((req) =>
    appointments.schedulingContext(req.user.id, req.user.companyId),
  ),
);
router.get(
  "/bm/schedule/leads/lead/:leadId",
  authRequired,
  bookingHandler((req) =>
    appointments.bookingLead(
      req.user.id,
      req.user.companyId,
      req.params.leadId,
    ),
  ),
);
router.get(
  "/bm/schedule/leads/calendars/:advisorId",
  authRequired,
  bookingHandler((req) =>
    appointments.getCalendar(
      req.user.id,
      req.user.companyId,
      req.params.advisorId,
    ),
  ),
);
router.put(
  "/bm/schedule/leads/calendars/:advisorId",
  authRequired,
  bookingHandler((req) =>
    appointments.saveCalendar(
      req.user.id,
      req.user.companyId,
      req.params.advisorId,
      req.body,
    ),
  ),
);
router.get(
  "/bm/schedule/leads/availability",
  authRequired,
  bookingHandler((req) =>
    appointments.availability(req.user.id, req.user.companyId, req.query),
  ),
);
router.get(
  "/bm/schedule/leads/appointments",
  authRequired,
  bookingHandler((req) =>
    appointments.listAppointments(req.user.id, req.user.companyId, req.query),
  ),
);
router.post(
  "/bm/schedule/leads/appointments",
  authRequired,
  bookingHandler((req) =>
    appointments.mutateAppointment(
      req.user.id,
      req.user.companyId,
      "book",
      null,
      req.body,
    ),
  ),
);
router.post(
  "/bm/schedule/leads/appointments/:id/reschedule",
  authRequired,
  bookingHandler((req) =>
    appointments.mutateAppointment(
      req.user.id,
      req.user.companyId,
      "reschedule",
      req.params.id,
      req.body,
    ),
  ),
);
router.post(
  "/bm/schedule/leads/appointments/:id/cancel",
  authRequired,
  bookingHandler((req) =>
    appointments.mutateAppointment(
      req.user.id,
      req.user.companyId,
      "cancel",
      req.params.id,
      req.body,
    ),
  ),
);

router.get("/bm/schedule", authRequired, listSchedules);
router.get("/bm/schedule/items", authRequired, listScheduleItems);
router.post("/bm/schedule", authRequired, createSchedule);
router.put("/bm/schedule/:scheduleId", authRequired, updateSchedule);
router.delete("/bm/schedule/:scheduleId", authRequired, deleteSchedule);

export default router;
