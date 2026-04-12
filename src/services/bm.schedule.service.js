import * as model from "../models/bm.schedule.model.js";
import * as projectsModel from "../models/bm.projects.model.js";

const SUPPORTED_SCHEDULE_TYPES = new Set(["project"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function stripRichText(value) {
  return normalizeText(
    String(value || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " "),
  ).replace(/\s+/g, " ");
}

function normalizeDate(value) {
  const date = normalizeText(value);
  if (!ISO_DATE_RE.test(date)) {
    throw httpError("date must use YYYY-MM-DD format", 400);
  }
  return date;
}

function timeToMinutes(value) {
  const normalized = normalizeText(value);
  if (!TIME_RE.test(normalized)) {
    throw httpError("time must use HH:MM format", 400);
  }

  const [hoursRaw, minutesRaw] = normalized.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);

  if (
    !Number.isInteger(hours)
    || !Number.isInteger(minutes)
    || hours < 0
    || hours > 23
    || minutes < 0
    || minutes > 59
  ) {
    throw httpError("time must use HH:MM format", 400);
  }

  if (minutes % 15 !== 0) {
    throw httpError("time must use 15-minute increments", 400);
  }

  return hours * 60 + minutes;
}

function normalizeTime(value, fieldName) {
  try {
    timeToMinutes(value);
  } catch (error) {
    throw httpError(`${fieldName} ${error.message}`, error.status ?? 400);
  }

  return normalizeText(value);
}

function validateTimeRange(startTime, endTime) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  if (startMinutes >= endMinutes) {
    throw httpError("start_time cannot be after or equal to end_time", 400);
  }
}

function normalizeScheduledItemType(value) {
  const type = normalizeText(value || "project").toLowerCase();
  if (!type) {
    throw httpError("scheduled_item_type is required", 400);
  }

  if (!SUPPORTED_SCHEDULE_TYPES.has(type)) {
    throw httpError(
      `scheduled_item_type '${type}' is not supported yet`,
      400,
    );
  }

  return type;
}

async function resolveScheduledItem(companyId, payload) {
  const scheduledItemType = normalizeScheduledItemType(
    payload.scheduled_item_type ?? payload.scheduledItemType,
  );
  const scheduledItemId = normalizeText(
    payload.scheduled_item_id
      ?? payload.scheduledItemId
      ?? payload.project_id
      ?? payload.projectId,
  );

  if (!scheduledItemId) {
    throw httpError("scheduled_item_id is required", 400);
  }

  if (scheduledItemType === "project") {
    const project = await projectsModel.getProject(companyId, scheduledItemId);
    if (!project) {
      throw httpError("Scheduled project not found", 404);
    }

    return {
      scheduled_item_type: "project",
      scheduled_item_id: project.projectId,
      scheduled_item_label: normalizeText(project.projectName),
      scheduled_item_secondary_label: normalizeText(project.clientName) || null,
      project_id: project.projectId,
    };
  }

  throw httpError(
    `scheduled_item_type '${scheduledItemType}' is not supported yet`,
    400,
  );
}

function normalizeDescription(value) {
  const description = normalizeText(String(value || ""));
  const plainText = stripRichText(description);
  if (!plainText) {
    throw httpError("description is required", 400);
  }
  return description;
}

function normalizeRangeDate(value, fieldName) {
  const date = normalizeText(value);
  if (!ISO_DATE_RE.test(date)) {
    throw httpError(`${fieldName} must use YYYY-MM-DD format`, 400);
  }
  return date;
}

async function normalizeOptionalProjectId(companyId, value) {
  const projectId = normalizeText(value);
  if (!projectId) {
    return null;
  }

  const project = await projectsModel.getProject(companyId, projectId);
  if (!project) {
    throw httpError("Scheduled project not found", 404);
  }

  return project.projectId;
}

function isExclusionViolation(error) {
  return error?.code === "23P01";
}

function mapScheduleWriteError(error) {
  if (isExclusionViolation(error)) {
    throw httpError("The selected time is no longer available", 409);
  }

  throw error;
}

export async function listSchedules(companyId, { start, end, projectId }) {
  const startDate = normalizeRangeDate(start, "start");
  const endDate = normalizeRangeDate(end, "end");
  const safeProjectId = await normalizeOptionalProjectId(companyId, projectId);

  if (startDate > endDate) {
    throw httpError("start cannot be after end", 400);
  }

  return model.listSchedules(companyId, {
    start: startDate,
    end: endDate,
    projectId: safeProjectId,
  });
}

export async function listScheduleItems(companyId, { q, type, limit }) {
  const safeType = normalizeScheduledItemType(type || "project");
  const safeLimit = clamp(Number(limit) || 10, 1, 20);
  return model.searchScheduledItems(companyId, {
    q: normalizeText(q),
    type: safeType,
    limit: safeLimit,
  });
}

export async function createSchedule(companyId, userId, payload) {
  const date = normalizeDate(payload.date);
  const startTime = normalizeTime(payload.start_time ?? payload.startTime, "start_time");
  const endTime = normalizeTime(payload.end_time ?? payload.endTime, "end_time");
  const description = normalizeDescription(payload.description);
  const scheduledItem = await resolveScheduledItem(companyId, payload);

  validateTimeRange(startTime, endTime);

  try {
    return await model.createSchedule(companyId, userId, {
      ...scheduledItem,
      date,
      start_time: startTime,
      end_time: endTime,
      description,
    });
  } catch (error) {
    mapScheduleWriteError(error);
  }
}

export async function updateSchedule(companyId, scheduleId, payload) {
  const existing = await model.getSchedule(companyId, scheduleId);
  if (!existing) {
    return null;
  }

  const date = normalizeDate(payload.date ?? existing.date);
  const startTime = normalizeTime(
    payload.start_time ?? payload.startTime ?? existing.startTime,
    "start_time",
  );
  const endTime = normalizeTime(
    payload.end_time ?? payload.endTime ?? existing.endTime,
    "end_time",
  );
  const description = normalizeDescription(
    payload.description ?? existing.description,
  );
  const scheduledItem = await resolveScheduledItem(companyId, {
    scheduled_item_type:
      payload.scheduled_item_type
      ?? payload.scheduledItemType
      ?? existing.scheduledItemType,
    scheduled_item_id:
      payload.scheduled_item_id
      ?? payload.scheduledItemId
      ?? payload.project_id
      ?? payload.projectId
      ?? existing.projectId
      ?? existing.scheduledItemId,
  });

  validateTimeRange(startTime, endTime);

  try {
    return await model.updateSchedule(companyId, scheduleId, {
      ...scheduledItem,
      date,
      start_time: startTime,
      end_time: endTime,
      description,
    });
  } catch (error) {
    mapScheduleWriteError(error);
  }
}
