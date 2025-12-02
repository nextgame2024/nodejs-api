import axios from "axios";
import { point, booleanPointInPolygon, pointToLineDistance } from "@turf/turf";

const NOISE_URL =
  process.env.TRANSPORT_NOISE_GEOJSON_URL ||
  "https://files-nodejs-api.s3.ap-southeast-2.amazonaws.com/public/cp14-transport-noise-corridor-overlay.geojson";

let noisePromise = null;

async function loadNoiseGeoJSON() {
  if (!noisePromise) {
    noisePromise = axios
      .get(NOISE_URL, { responseType: "json" })
      .then((res) => res.data)
      .catch((err) => {
        noisePromise = null;
        console.error(
          "[planner] Failed to load transport noise GeoJSON:",
          err.message
        );
        throw new Error("Unable to load transport noise dataset");
      });
  }
  return noisePromise;
}

/**
 * Approximate check for whether a site is in / near a transport noise corridor.
 */
export async function lookupTransportNoiseForPoint({ lng, lat }) {
  const geojson = await loadNoiseGeoJSON();
  const pt = point([lng, lat]);
  const features = geojson.features || [];

  let match = null;

  for (const feature of features) {
    const geom = feature.geometry;
    if (!geom) continue;

    try {
      if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
        if (booleanPointInPolygon(pt, feature)) {
          match = feature;
          break;
        }
      } else if (
        geom.type === "LineString" ||
        geom.type === "MultiLineString"
      ) {
        const distMeters = pointToLineDistance(pt, feature, {
          units: "meters",
        });
        // 50m threshold – rough but fine for pre-assessment
        if (distMeters <= 50) {
          match = feature;
          break;
        }
      }
    } catch {
      // ignore bad geometry
    }
  }

  if (!match) {
    return {
      hasTransportNoiseCorridor: false,
      overlays: [],
      rawFeature: null,
    };
  }

  return {
    hasTransportNoiseCorridor: true,
    overlays: [
      {
        name: "Transport noise corridor",
        code: "transport_noise_corridor",
        severity: "near state-controlled road",
      },
    ],
    rawFeature: {
      id: match.id || match.properties?.ogc_fid || null,
      properties: match.properties || {},
    },
  };
}
