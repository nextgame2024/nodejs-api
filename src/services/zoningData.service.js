import axios from "axios";
import * as turf from "@turf/turf";

// You can override this in Render dashboard
const ZONING_GEOJSON_URL =
  process.env.ZONING_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-zoning-overlay.geojson";

let zoningDatasetPromise = null;

/**
 * Fetch and cache the zoning GeoJSON from S3.
 */
async function loadZoningGeoJSON() {
  if (!ZONING_GEOJSON_URL) {
    throw new Error("ZONING_GEOJSON_URL env var is required");
  }

  if (!zoningDatasetPromise) {
    zoningDatasetPromise = axios
      .get(ZONING_GEOJSON_URL, { responseType: "json" })
      .then((res) => res.data)
      .catch((err) => {
        zoningDatasetPromise = null; // allow retry next request
        console.error("[planner] Failed to load zoning GeoJSON:", err.message);
        throw new Error("Unable to load zoning dataset");
      });
  }

  return zoningDatasetPromise;
}

/**
 * Look up zoning for a given point (lng/lat).
 * Returns best-effort info – if field names change we just fall back to nulls.
 */
export async function lookupZoningForPoint({ lng, lat }) {
  const geojson = await loadZoningGeoJSON();
  const pt = turf.point([lng, lat]);
  const features = geojson.features || [];

  let match = null;

  for (const feature of features) {
    if (!feature?.geometry) continue;

    try {
      if (turf.booleanPointInPolygon(pt, feature)) {
        match = feature;
        break;
      }
    } catch (err) {
      // ignore invalid geometries, keep scanning
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

  // Best guess at common field names in cp14-zoning-overlay
  const zoningName =
    props.zone_prec_desc ||
    props.zone_desc ||
    props.ZONE_DESC ||
    props.ZONE_NAME ||
    null;

  const zoningCode = props.zone_code || props.ZONE_CODE || props.ZONE || null;

  // Many zoning polygons won't have a neighbourhood plan; we keep this flexible.
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
