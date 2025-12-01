import axios from "axios";
import { lookupZoningForPoint } from "./zoningData.service.js";

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export async function fetchPlanningData({ address, lotPlan }) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error("GOOGLE_MAPS_API_KEY env var is required");
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

  // 2) Query zoning GeoJSON for this point
  const zoningInfo = await lookupZoningForPoint({ lng, lat });

  // 3) For now overlays are still stubbed – we'll add separate datasets later.
  return {
    geocode: {
      lat,
      lng,
      formattedAddress: result.formatted_address,
    },
    zoning: zoningInfo.zoningName || "Unknown zoning (no polygon match)",
    zoningCode: zoningInfo.zoningCode,
    neighbourhoodPlan: zoningInfo.neighbourhoodPlan,
    overlays: [
      // TODO: replace with real overlay data (flood, overland flow, etc)
    ],
    rawZoningFeature: zoningInfo.rawFeature,
  };
}
