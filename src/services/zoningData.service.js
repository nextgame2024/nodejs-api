import axios from "axios";
import { point, booleanPointInPolygon } from "@turf/turf";

// Zoning GeoJSON (cp14-zoning-overlay.geojson)
const ZONING_GEOJSON_URL =
  process.env.ZONING_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-zoning-overlay.geojson";

let zoningDatasetPromise = null;

/**
 * Fetch and cache the zoning GeoJSON from S3.
 */
async function loadZoningGeoJSON() {
  if (!ZONING_GEOJSON_URL) {
    console.error("[planner] ZONING_GEOJSON_URL is not configured");
    throw new Error("Zoning dataset URL not configured");
  }

  if (!zoningDatasetPromise) {
    zoningDatasetPromise = axios
      .get(ZONING_GEOJSON_URL, { responseType: "json" })
      .then((res) => res.data)
      .catch((err) => {
        zoningDatasetPromise = null;
        console.error("[planner] Failed to load zoning GeoJSON:", err.message);
        throw new Error("Unable to load zoning dataset");
      });
  }

  return zoningDatasetPromise;
}

/**
 * Look up zoning for a given point (lng/lat).
 */
export async function lookupZoningForPoint({ lng, lat }) {
  const geojson = await loadZoningGeoJSON();
  const pt = point([lng, lat]);
  const features = geojson.features || [];

  let match = null;

  for (const feature of features) {
    if (!feature?.geometry) continue;

    try {
      if (booleanPointInPolygon(pt, feature)) {
        match = feature;
        break;
      }
    } catch {
      // ignore invalid geometries
    }
  }

  if (!match) {
    return {
      zoningCode: null,
      zoningName: null,
      neighbourhoodPlan: null,
      rawFeature: null,
    };
  }

  const props = match.properties || {};

  const zoningName =
    props.zone_prec_desc ||
    props.zone_desc ||
    props.ZONE_DESC ||
    props.ZONE_NAME ||
    null;

  const zoningCode = props.zone_code || props.ZONE_CODE || props.ZONE || null;

  const neighbourhoodPlan =
    props.neighbourhood_plan_precinct ||
    props.neighbourhood_plan_prec_desc ||
    props.NP_PREC_DESC ||
    null;

  return {
    zoningCode,
    zoningName,
    neighbourhoodPlan,
    rawFeature: {
      id: match.id || props.ogc_fid || null,
      properties: props,
    },
  };
}
