import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.schedule.service.js";

export const listSchedules = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { start, end, project_id: projectId } = req.query;

  const schedules = await service.listSchedules(companyId, {
    start,
    end,
    projectId,
  });

  res.json({ schedules });
});

export const listScheduleItems = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { q, type = "project", limit = "10" } = req.query;

  const items = await service.listScheduleItems(companyId, {
    q,
    type,
    limit: Number(limit),
  });

  res.json({ items });
});

export const createSchedule = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.user.id;
  const payload = req.body?.schedule || req.body || {};

  const schedule = await service.createSchedule(companyId, userId, payload);

  res.status(201).json({ schedule });
});

export const updateSchedule = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { scheduleId } = req.params;
  const payload = req.body?.schedule || req.body || {};

  const schedule = await service.updateSchedule(companyId, scheduleId, payload);
  if (!schedule) {
    return res.status(404).json({ error: "Schedule not found" });
  }

  res.json({ schedule });
});

export const deleteSchedule = asyncHandler(async (req, res) => {
  const companyId = req.user.companyId;
  const { scheduleId } = req.params;

  const deleted = await service.deleteSchedule(companyId, scheduleId);
  if (!deleted) {
    return res.status(404).json({ error: "Schedule not found" });
  }

  res.json({ scheduleId: deleted.scheduleId });
});
