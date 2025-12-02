import axios from "axios";
import { point, booleanPointInPolygon } from "@turf/turf";

const FLOOD_OVERLAND_URL =
  process.env.FLOOD_OVERLAND_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-flood-overlay-overland-flow.geojson";

const FLOOD_CREEK_URL =
  process.env.FLOOD_CREEK_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-flood-overlay-creek-waterway-flood-planning-area.geojson";

const FLOOD_BRISBANE_RIVER_URL =
  process.env.FLOOD_BRISBANE_RIVER_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-flood-overlay-brisbane-river-flood-planning-area.geojson";

let overlandPromise = null;
let creekPromise = null;
let brisbaneRiverPromise = null;

function loadFlood(url, cacheRef, label) {
  if (!cacheRef.current) {
    cacheRef.current = axios
      .get(url, { responseType: "json" })
      .then((res) => res.data)
      .catch((err) => {
        cacheRef.current = null;
        console.error(
          `[planner] Failed to load ${label} GeoJSON:`,
          err.message
        );
        throw new Error(`Unable to load ${label} dataset`);
      });
  }
  return cacheRef.current;
}

// little helper so we can mutate primitive refs
function makeRef() {
  return { current: null };
}

const overlandRef = makeRef();
const creekRef = makeRef();
const brisbaneRiverRef = makeRef();

async function firstIntersectingFeature(geojson, pt) {
  for (const feature of geojson.features || []) {
    if (!feature?.geometry) continue;
    try {
      if (booleanPointInPolygon(pt, feature)) {
        return feature;
      }
    } catch {
      // ignore invalid
    }
  }
  return null;
}

/**
 * Find flood overlays that apply at this point.
 */
export async function lookupFloodOverlaysForPoint({ lng, lat }) {
  const pt = point([lng, lat]);
  const overlays = [];
  const rawFeatures = [];

  // Overland flow
  try {
    const overland = await loadFlood(
      FLOOD_OVERLAND_URL,
      overlandRef,
      "flood overland"
    );
    const match = await firstIntersectingFeature(overland, pt);
    if (match) {
      overlays.push({
        name: "Flood overlay – overland flow",
        code: "flood_overland_flow",
        severity: "overland flow",
      });
      rawFeatures.push({
        source: "overland",
        id: match.id || match.properties?.ogc_fid || null,
        properties: match.properties || {},
      });
    }
  } catch (err) {
    console.error(
      "[planner] Overland flood lookup failed:",
      err?.message || err
    );
  }

  // Creek / waterway
  try {
    const creek = await loadFlood(
      FLOOD_CREEK_URL,
      creekRef,
      "flood creek/waterway"
    );
    const match = await firstIntersectingFeature(creek, pt);
    if (match) {
      overlays.push({
        name: "Flood overlay – creek/waterway",
        code: "flood_creek_waterway",
        severity: "creek/waterway flood planning area",
      });
      rawFeatures.push({
        source: "creek_waterway",
        id: match.id || match.properties?.ogc_fid || null,
        properties: match.properties || {},
      });
    }
  } catch (err) {
    console.error(
      "[planner] Creek/waterway flood lookup failed:",
      err?.message || err
    );
  }

  // Brisbane River
  try {
    const river = await loadFlood(
      FLOOD_BRISBANE_RIVER_URL,
      brisbaneRiverRef,
      "flood brisbane river"
    );
    const match = await firstIntersectingFeature(river, pt);
    if (match) {
      overlays.push({
        name: "Flood overlay – Brisbane River flood planning area",
        code: "flood_brisbane_river",
        severity: "Brisbane River flood planning area",
      });
      rawFeatures.push({
        source: "brisbane_river",
        id: match.id || match.properties?.ogc_fid || null,
        properties: match.properties || {},
      });
    }
  } catch (err) {
    console.error(
      "[planner] Brisbane River flood lookup failed:",
      err?.message || err
    );
  }

  return {
    overlays,
    rawFeatures,
  };
}
