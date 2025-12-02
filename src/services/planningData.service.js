import axios from "axios";
import { lookupZoningForPoint } from "./zoningData.service.js";
import { lookupNeighbourhoodPlanForPoint } from "./neighbourhoodPlanData.service.js";
import { lookupFloodOverlaysForPoint } from "./floodOverlayData.service.js";
import { lookupTransportNoiseForPoint } from "./transportNoiseData.service.js";

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export async function fetchPlanningData({ address, lotPlan }) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error("[planner] GOOGLE_MAPS_API_KEY is missing");
    throw new Error("Google Maps API key is not configured");
  }

  // 1) Geocode address
  const { data } = await axios.get(GOOGLE_GEOCODE_URL, {
    params: {
      address,
      key: process.env.GOOGLE_MAPS_API_KEY,
    },
  });

  const result = data.results?.[0];
  if (!result) {
    throw new Error("Unable to geocode address");
  }

  const lng = result.geometry.location.lng;
  const lat = result.geometry.location.lat;

  // Default structures so we always return something
  let zoningInfo = {
    zoningCode: null,
    zoningName: null,
    neighbourhoodPlan: null,
    rawFeature: null,
  };
  let npInfo = {
    neighbourhoodPlan: null,
    neighbourhoodPlanCode: null,
    neighbourhoodPlanPrecinct: null,
    neighbourhoodPlanPrecinctCode: null,
    rawBoundaryFeature: null,
    rawPrecinctFeature: null,
  };
  let floodInfo = { overlays: [], rawFeatures: [] };
  let noiseInfo = {
    hasTransportNoiseCorridor: false,
    overlays: [],
    rawFeature: null,
  };

  // 2) Zoning
  try {
    zoningInfo = await lookupZoningForPoint({ lng, lat });
  } catch (err) {
    console.error("[planner] Zoning lookup failed:", err?.message || err);
  }

  // 3) Neighbourhood plan
  try {
    npInfo = await lookupNeighbourhoodPlanForPoint({ lng, lat });
  } catch (err) {
    console.error(
      "[planner] Neighbourhood plan lookup failed:",
      err?.message || err
    );
  }

  // 4) Flood overlays
  try {
    floodInfo = await lookupFloodOverlaysForPoint({ lng, lat });
  } catch (err) {
    console.error(
      "[planner] Flood overlay lookup failed:",
      err?.message || err
    );
  }

  // 5) Transport noise
  try {
    noiseInfo = await lookupTransportNoiseForPoint({ lng, lat });
  } catch (err) {
    console.error(
      "[planner] Transport noise lookup failed:",
      err?.message || err
    );
  }

  // Merge overlays into a single list (for Gemini + UI)
  const overlays = [
    ...(floodInfo.overlays || []),
    ...(noiseInfo.overlays || []),
  ];

  return {
    geocode: {
      lat,
      lng,
      formattedAddress: result.formatted_address,
    },
    zoning: zoningInfo.zoningName || "Unknown (no zoning match)",
    zoningCode: zoningInfo.zoningCode,
    neighbourhoodPlan:
      npInfo.neighbourhoodPlan || zoningInfo.neighbourhoodPlan || null,
    neighbourhoodPlanCode: npInfo.neighbourhoodPlanCode,
    neighbourhoodPlanPrecinct: npInfo.neighbourhoodPlanPrecinct,
    neighbourhoodPlanPrecinctCode: npInfo.neighbourhoodPlanPrecinctCode,
    hasTransportNoiseCorridor: noiseInfo.hasTransportNoiseCorridor,
    overlays,
    rawZoningFeature: zoningInfo.rawFeature,
    rawNeighbourhoodPlanBoundary: npInfo.rawBoundaryFeature,
    rawNeighbourhoodPlanPrecinct: npInfo.rawPrecinctFeature,
    rawFloodFeatures: floodInfo.rawFeatures,
    rawTransportNoiseFeature: noiseInfo.rawFeature,
  };
}
