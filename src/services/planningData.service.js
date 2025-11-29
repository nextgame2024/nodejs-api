// src/services/planningData.service.js
import axios from "axios";

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export async function fetchPlanningData({ address, lotPlan }) {
  if (!address) {
    throw new Error("Address is required to fetch planning data");
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY env var is not set");
  }

  // 1) Geocode address
  const { data } = await axios.get(GOOGLE_GEOCODE_URL, {
    params: {
      address,
      key: apiKey,
      // You can add components=country:AU if you like:
      // components: "country:AU",
    },
  });

  if (data.status !== "OK" || !data.results?.length) {
    throw new Error(
      `Geocoding failed: ${data.status || "UNKNOWN"}${
        data.error_message ? ` - ${data.error_message}` : ""
      }`
    );
  }

  const result = data.results[0];
  const { lat, lng } = result.geometry.location;

  // 2) Get zoning / overlays / neighbourhood plan from your own data.
  const planningLayers = await lookupPlanningLayers({ lat, lng, lotPlan });

  return {
    geocode: {
      lat,
      lng,
      formattedAddress: result.formatted_address,
      placeId: result.place_id,
    },
    ...planningLayers,
  };
}

/**
 * TODO: Replace this stub with real GIS / planning DB integration.
 * This is the “single place” in your backend where zoning/overlays are resolved.
 */
async function lookupPlanningLayers({ lat, lng, lotPlan }) {
  // TODO (future):
  // - Query your own PostGIS / data service using lat/lng
  // - Or call a BCC / QLD govt API, if available and allowed
  // - Use lotPlan if you have lot-based datasets

  // For now we keep your example hard-coded so everything works end-to-end.
  return {
    zoning: "Low Density Residential (LDR)",
    neighbourhoodPlan: "Chermside Centre Neighbourhood Plan",
    overlays: [
      { name: "Flood Overlay", severity: "minor" },
      { name: "Overland Flow Overlay", severity: "present" },
      { name: "Transport Noise Corridor", severity: "minor" },
    ],
  };
}
