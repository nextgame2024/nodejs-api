// src/services/bm.projects.service.js
import axios from "axios";
import * as model from "../models/bm.projects.model.js";
import * as companyModel from "../models/bm.company.model.js";
import { createDocumentFromProject as createDocFromProject } from "../models/bm.documents.model.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const toMoney = (value) => Math.round(Number(value) * 100) / 100;
const SURCHARGE_TYPES = new Set(["transportation", "other"]);

const DISTANCE_MATRIX_URL =
  "https://maps.googleapis.com/maps/api/distancematrix/json";
const ROUTES_COMPUTE_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";
const DIRECTIONS_API_URL = "https://maps.googleapis.com/maps/api/directions/json";
const TRANSPORTATION_GENERIC_ERROR =
  "Unable to calculate transportation time right now.";

function normalizeAddress(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function getGoogleMapsKey() {
  const key =
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY_SERVER ||
    "";
  if (!key) {
    const err = new Error("Google Maps API key is not configured");
    err.status = 503;
    throw err;
  }
  return key;
}

function formatTravelTime(totalMinutesRaw) {
  const totalMinutes = Math.max(0, Math.round(Number(totalMinutesRaw) || 0));
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hoursLabel = `${hours} hour${hours === 1 ? "" : "s"}`;
  if (!minutes) return hoursLabel;
  return `${hoursLabel} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function parseDurationSeconds(rawDuration) {
  const value = String(rawDuration || "")
    .trim()
    .toLowerCase();
  if (!value.endsWith("s")) return NaN;
  return Number(value.slice(0, -1));
}

function buildTransportationServiceError(rawMessage, status = 502) {
  const message = String(rawMessage || "").trim();
  const lower = message.toLowerCase();

  if (
    lower.includes("not authorized to use this service or api") ||
    lower.includes("api restrictions") ||
    lower.includes("referer restrictions") ||
    lower.includes("are blocked") ||
    lower.includes("api not activated")
  ) {
    const err = new Error(
      "Unable to calculate transportation route right now. Google routing APIs are blocked for this API key. Enable Routes API and/or Directions API in Google Cloud and include them in API key restrictions."
    );
    err.status = 503;
    return err;
  }

  if (lower.includes("billing")) {
    const err = new Error(
      "Unable to calculate transportation time. Google Maps billing is not enabled for this project."
    );
    err.status = 503;
    return err;
  }

  const err = new Error(
    message ? `${TRANSPORTATION_GENERIC_ERROR} ${message}` : TRANSPORTATION_GENERIC_ERROR
  );
  err.status = status;
  return err;
}

function extractUpstreamErrorMessage(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.error_message ||
    error?.response?.data?.message ||
    error?.message ||
    ""
  );
}

async function fetchTravelDurationSeconds(companyAddress, clientAddress) {
  const key = getGoogleMapsKey();

  let data = null;
  try {
    const response = await axios.get(DISTANCE_MATRIX_URL, {
      params: {
        origins: companyAddress,
        destinations: clientAddress,
        mode: "driving",
        units: "metric",
        key,
      },
      timeout: 10_000,
    });
    data = response?.data;
  } catch (error) {
    const upstream =
      error?.response?.data?.error_message ||
      error?.response?.data?.message ||
      error?.message ||
      "";
    throw buildTransportationServiceError(upstream, 502);
  }

  if (data?.status !== "OK") {
    throw buildTransportationServiceError(
      data?.error_message || data?.status || "",
      502
    );
  }

  const element = data?.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK") {
    if (element?.status === "ZERO_RESULTS") {
      const err = new Error(
        "Unable to calculate transportation time. No driving route was found between company and client addresses."
      );
      err.status = 400;
      throw err;
    }
    if (element?.status === "NOT_FOUND") {
      const err = new Error(
        "Unable to calculate transportation time. One or both addresses are invalid."
      );
      err.status = 400;
      throw err;
    }
    const err = new Error(
      `Unable to calculate transportation time. ${
        element?.status || "Route not found"
      }`
    );
    err.status = 400;
    throw err;
  }

  const durationSeconds = Number(element?.duration?.value);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    const err = new Error("Unable to calculate transportation time");
    err.status = 502;
    throw err;
  }

  return durationSeconds;
}

async function fetchDrivingRouteSummary(companyAddress, clientAddress) {
  try {
    return await fetchDrivingRouteSummaryFromRoutesApi(
      companyAddress,
      clientAddress
    );
  } catch (routesError) {
    try {
      return await fetchDrivingRouteSummaryFromDirectionsApi(
        companyAddress,
        clientAddress
      );
    } catch (directionsError) {
      const primaryMessage = extractUpstreamErrorMessage(directionsError);
      const fallbackMessage = extractUpstreamErrorMessage(routesError);
      throw buildTransportationServiceError(
        primaryMessage || fallbackMessage,
        502
      );
    }
  }
}

async function fetchDrivingRouteSummaryFromRoutesApi(
  companyAddress,
  clientAddress
) {
  const key = getGoogleMapsKey();

  let data = null;
  try {
    const response = await axios.post(
      ROUTES_COMPUTE_URL,
      {
        origin: { address: companyAddress },
        destination: { address: clientAddress },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        computeAlternativeRoutes: false,
        languageCode: "en-AU",
        units: "METRIC",
      },
      {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
        },
        timeout: 12_000,
      }
    );
    data = response?.data;
  } catch (error) {
    const upstream = extractUpstreamErrorMessage(error);
    const err = new Error(upstream || "Routes API request failed");
    err.status = 502;
    throw err;
  }

  const route = data?.routes?.[0];
  if (!route) {
    const err = new Error(
      "Unable to calculate transportation route. No driving route was returned."
    );
    err.status = 400;
    throw err;
  }

  const encodedPolyline = String(route?.polyline?.encodedPolyline || "").trim();
  if (!encodedPolyline) {
    const err = new Error(
      "Unable to calculate transportation route. Route polyline is unavailable."
    );
    err.status = 502;
    throw err;
  }

  const durationSeconds = parseDurationSeconds(route?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    const err = new Error("Unable to calculate transportation route duration");
    err.status = 502;
    throw err;
  }

  const distanceMeters = Number(route?.distanceMeters);
  return {
    encodedPolyline,
    durationSeconds,
    distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : null,
  };
}

async function fetchDrivingRouteSummaryFromDirectionsApi(
  companyAddress,
  clientAddress
) {
  const key = getGoogleMapsKey();

  let data = null;
  try {
    const response = await axios.get(DIRECTIONS_API_URL, {
      params: {
        origin: companyAddress,
        destination: clientAddress,
        mode: "driving",
        units: "metric",
        key,
      },
      timeout: 12_000,
    });
    data = response?.data;
  } catch (error) {
    const upstream = extractUpstreamErrorMessage(error);
    const err = new Error(upstream || "Directions API request failed");
    err.status = 502;
    throw err;
  }

  if (data?.status !== "OK") {
    const upstream = data?.error_message || data?.status || "";
    const err = new Error(upstream || "Directions API request failed");
    err.status = 502;
    throw err;
  }

  const route = data?.routes?.[0];
  const leg = route?.legs?.[0];
  const encodedPolyline = String(route?.overview_polyline?.points || "").trim();
  if (!encodedPolyline) {
    const err = new Error("Directions API did not return route geometry");
    err.status = 502;
    throw err;
  }

  const durationSeconds = Number(leg?.duration?.value);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    const err = new Error("Directions API did not return route duration");
    err.status = 502;
    throw err;
  }

  const distanceMeters = Number(leg?.distance?.value);
  return {
    encodedPolyline,
    durationSeconds,
    distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : null,
  };
}

export async function listProjects(
  companyId,
  { q, status, clientId, page, limit }
) {
  const safeLimit = clamp(Number(limit) || 20, 1, 100);
  const safePage = clamp(Number(page) || 1, 1, 10_000);
  const offset = (safePage - 1) * safeLimit;

  const [projects, total] = await Promise.all([
    model.listProjects(companyId, {
      q,
      status,
      clientId,
      limit: safeLimit,
      offset,
    }),
    model.countProjects(companyId, { q, status, clientId }),
  ]);

  return { projects, page: safePage, limit: safeLimit, total };
}

export const getProject = (companyId, projectId) =>
  model.getProject(companyId, projectId);
export const createProject = (companyId, userId, payload) =>
  model.createProject(companyId, userId, payload);
export const updateProject = (companyId, projectId, payload) =>
  model.updateProject(companyId, projectId, payload);

export const removeProject = async (companyId, projectId) => {
  const ok = await model.softDeleteProject(companyId, projectId);
  return { ok, action: "deleted" };
};

// Project materials
export async function listProjectMaterials(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.listProjectMaterials(companyId, projectId);
}

export const upsertProjectMaterial = (
  companyId,
  projectId,
  materialId,
  payload
) => model.upsertProjectMaterial(companyId, projectId, materialId, payload);

export const removeProjectMaterial = (companyId, projectId, materialId) =>
  model.removeProjectMaterial(companyId, projectId, materialId);

// Project labor
export async function listProjectLabor(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.listProjectLabor(companyId, projectId);
}

export const upsertProjectLabor = (companyId, projectId, laborId, payload) =>
  model.upsertProjectLabor(companyId, projectId, laborId, payload);

export const removeProjectLabor = (companyId, projectId, laborId) =>
  model.removeProjectLabor(companyId, projectId, laborId);

// Project surcharges
export async function listProjectSurcharges(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.listProjectSurcharges(companyId, projectId);
}

export async function createProjectSurcharge(companyId, projectId, payload) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;

  const type = String(payload?.type || "")
    .trim()
    .toLowerCase();
  const name = String(payload?.name || "").trim();
  const cost = Number(payload?.cost);

  if (!type) {
    const err = new Error("type is required");
    err.status = 400;
    throw err;
  }
  if (!SURCHARGE_TYPES.has(type)) {
    const err = new Error("type must be transportation or other");
    err.status = 400;
    throw err;
  }
  if (!name) {
    const err = new Error("name is required");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(cost) || cost < 0) {
    const err = new Error("cost must be a valid non-negative number");
    err.status = 400;
    throw err;
  }

  if (type === "transportation") {
    const transportationExists = await model.projectHasSurchargeType(
      companyId,
      projectId,
      "transportation"
    );
    if (transportationExists) {
      const err = new Error(
        "Transportation surcharge already exists for this project"
      );
      err.status = 409;
      throw err;
    }
  }

  return model.createProjectSurcharge(companyId, projectId, {
    type,
    name,
    cost: toMoney(cost),
  });
}

export const removeProjectSurcharge = (companyId, projectId, surchargeId) =>
  model.removeProjectSurcharge(companyId, projectId, surchargeId);

export async function getProjectSurchargeTransportationTime(
  companyId,
  projectId
) {
  const project = await model.getProject(companyId, projectId);
  if (!project) return null;

  const company = await companyModel.getCompany(companyId, companyId);
  const companyAddress = normalizeAddress(company?.address);
  const clientAddress = normalizeAddress(project?.clientAddress);

  if (!companyAddress) {
    const err = new Error("Company address is required to calculate travel time");
    err.status = 400;
    throw err;
  }
  if (!clientAddress) {
    const err = new Error("Client address is required to calculate travel time");
    err.status = 400;
    throw err;
  }

  const durationSeconds = await fetchTravelDurationSeconds(
    companyAddress,
    clientAddress
  );
  const durationMinutes = Math.max(0, Math.round(durationSeconds / 60));

  return {
    companyAddress,
    clientAddress,
    durationMinutes,
    formattedTime: formatTravelTime(durationMinutes),
  };
}

export async function getProjectSurchargeTransportationRoute(
  companyId,
  projectId
) {
  const project = await model.getProject(companyId, projectId);
  if (!project) return null;

  const company = await companyModel.getCompany(companyId, companyId);
  const companyAddress = normalizeAddress(company?.address);
  const clientAddress = normalizeAddress(project?.clientAddress);

  if (!companyAddress) {
    const err = new Error("Company address is required to calculate route");
    err.status = 400;
    throw err;
  }
  if (!clientAddress) {
    const err = new Error("Client address is required to calculate route");
    err.status = 400;
    throw err;
  }

  const route = await fetchDrivingRouteSummary(companyAddress, clientAddress);
  const durationMinutes = Math.max(0, Math.round(route.durationSeconds / 60));

  return {
    companyAddress,
    clientAddress,
    durationMinutes,
    formattedTime: formatTravelTime(durationMinutes),
    distanceMeters: route.distanceMeters,
    encodedPolyline: route.encodedPolyline,
  };
}

export async function getProjectLaborExtras(companyId, projectId) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;
  return model.getProjectLaborExtras(companyId, projectId);
}

export async function upsertProjectLaborExtras(companyId, projectId, payload) {
  const exists = await model.projectExists(companyId, projectId);
  if (!exists) return null;

  const dailyRateRaw = payload?.daily_rate ?? payload?.dailyRate;
  const laborHoursRaw = payload?.labor_hours ?? payload?.laborHours;

  const dailyRate = Number(dailyRateRaw);
  const laborHours = Number(laborHoursRaw);

  if (!Number.isFinite(dailyRate) || dailyRate < 0) {
    const err = new Error("dailyRate must be a valid non-negative number");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(laborHours) || laborHours < 0) {
    const err = new Error("laborHours must be a valid non-negative number");
    err.status = 400;
    throw err;
  }

  return model.upsertProjectLaborExtras(companyId, projectId, {
    dailyRate: toMoney(dailyRate),
    laborHours: toMoney(laborHours),
  });
}

/**
 * Create a quote/invoice from a project using its materials/labor.
 * Delegates to bm.documents.model.js helper.
 */
export async function createDocumentFromProject(
  companyId,
  userId,
  projectId,
  payload
) {
  return createDocFromProject(companyId, userId, projectId, payload);
}
