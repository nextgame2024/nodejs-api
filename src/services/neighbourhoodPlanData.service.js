import axios from "axios";
import { point, booleanPointInPolygon } from "@turf/turf";

// Boundaries + precincts GeoJSON
const NP_BOUNDARIES_URL =
  process.env.NP_BOUNDARIES_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-neighbourhood-plan-boundaries.geojson";

const NP_PRECINCTS_URL =
  process.env.NP_PRECINCTS_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-neighbourhood-plan-precincts.geojson";

let boundariesPromise = null;
let precinctsPromise = null;

async function loadBoundaries() {
  if (!boundariesPromise) {
    boundariesPromise = axios
      .get(NP_BOUNDARIES_URL, { responseType: "json" })
      .then((res) => res.data)
      .catch((err) => {
        boundariesPromise = null;
        console.error(
          "[planner] Failed to load NP boundaries GeoJSON:",
          err.message
        );
        throw new Error("Unable to load neighbourhood plan boundaries");
      });
  }
  return boundariesPromise;
}

async function loadPrecincts() {
  if (!precinctsPromise) {
    precinctsPromise = axios
      .get(NP_PRECINCTS_URL, { responseType: "json" })
      .then((res) => res.data)
      .catch((err) => {
        precinctsPromise = null;
        console.error(
          "[planner] Failed to load NP precincts GeoJSON:",
          err.message
        );
        throw new Error("Unable to load neighbourhood plan precincts");
      });
  }
  return precinctsPromise;
}

/**
 * Lookup neighbourhood plan & precinct for a given point.
 */
export async function lookupNeighbourhoodPlanForPoint({ lng, lat }) {
  const pt = point([lng, lat]);

  let boundaryMatch = null;
  let precinctMatch = null;

  // Boundaries
  try {
    const boundaries = await loadBoundaries();
    for (const feature of boundaries.features || []) {
      if (!feature?.geometry) continue;
      try {
        if (booleanPointInPolygon(pt, feature)) {
          boundaryMatch = feature;
          break;
        }
      } catch {
        // ignore invalid geom
      }
    }
  } catch (err) {
    console.error("[planner] NP boundary lookup failed:", err?.message || err);
  }

  // Precincts (more detailed if available)
  try {
    const precincts = await loadPrecincts();
    for (const feature of precincts.features || []) {
      if (!feature?.geometry) continue;
      try {
        if (booleanPointInPolygon(pt, feature)) {
          precinctMatch = feature;
          break;
        }
      } catch {
        // ignore
      }
    }
  } catch (err) {
    console.error("[planner] NP precinct lookup failed:", err?.message || err);
  }

  const boundaryProps = boundaryMatch?.properties || {};
  const precinctProps = precinctMatch?.properties || {};

  const npName =
    boundaryProps.np_desc ||
    boundaryProps.np_name ||
    boundaryProps.NP_DESC ||
    boundaryProps.NP_NAME ||
    null;

  const npCode = boundaryProps.np_code || boundaryProps.NP_CODE || null;

  const npPrecinctName =
    precinctProps.npp_desc ||
    precinctProps.npp_name ||
    precinctProps.NPP_DESC ||
    precinctProps.NPP_NAME ||
    null;

  const npPrecinctCode =
    precinctProps.npp_code || precinctProps.NPP_CODE || null;

  return {
    neighbourhoodPlan: npName,
    neighbourhoodPlanCode: npCode,
    neighbourhoodPlanPrecinct: npPrecinctName,
    neighbourhoodPlanPrecinctCode: npPrecinctCode,
    rawBoundaryFeature: boundaryMatch
      ? {
          id: boundaryMatch.id || boundaryProps.ogc_fid || null,
          properties: boundaryProps,
        }
      : null,
    rawPrecinctFeature: precinctMatch
      ? {
          id: precinctMatch.id || precinctProps.ogc_fid || null,
          properties: precinctProps,
        }
      : null,
  };
}
