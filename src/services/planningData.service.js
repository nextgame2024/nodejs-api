// src/services/planningData.service.js
import axios from "axios";

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export async function fetchPlanningData({ address, lotPlan }) {
  // 1) Geocode address (Google or similar)
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

  const [lng, lat] = [
    result.geometry.location.lng,
    result.geometry.location.lat,
  ];

  // 2) TODO: call your own GIS / planning DB here.
  // For now, we’ll return the example payload hard-coded.

  return {
    geocode: {
      lat,
      lng,
      formattedAddress: result.formatted_address,
    },
    zoning: "Low Density Residential (LDR)",
    neighbourhoodPlan: "Chermside Centre Neighbourhood Plan",
    overlays: [
      { name: "Flood Overlay", severity: "minor" },
      { name: "Overland Flow Overlay", severity: "present" },
      { name: "Transport Noise Corridor", severity: "minor" },
    ],
  };
}
