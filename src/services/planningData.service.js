import axios from "axios";
import pgPkg from "pg";

const { Pool } = pgPkg;

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

// Prefer DATABASE_URL; fall back to DB_* env vars if you use those.
const connectionString =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST &&
    `postgres://${encodeURIComponent(
      process.env.DB_USER
    )}:${encodeURIComponent(process.env.DB_PASSWORD)}@${
      process.env.DB_HOST
    }:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE}`);

if (!connectionString) {
  console.error(
    "[planner] DATABASE_URL or DB_* env vars are required for PostGIS lookups"
  );
}

const pool = connectionString ? new Pool({ connectionString }) : null;

function readProp(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return obj[k];
    }
  }
  return null;
}

/**
 * Generic spatial lookup helper.
 *
 * - For polygon tables: uses ST_Contains(geom, point)
 * - For corridor/line tables: pass withinDistanceMeters to use ST_DWithin(...)
 */
async function queryOne(table, lng, lat, withinDistanceMeters) {
  if (!pool) return null;

  const pointExpr = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";
  let sql;

  if (typeof withinDistanceMeters === "number") {
    // For transport noise (lines / corridors) – use ST_DWithin on geography
    sql = `
      SELECT properties
      FROM ${table}
      WHERE ST_DWithin(
        geom::geography,
        (${pointExpr})::geography,
        $3
      )
      LIMIT 1;
    `;
  } else {
    // Polygons – use ST_Contains
    sql = `
      SELECT properties
      FROM ${table}
      WHERE ST_Contains(
        geom,
        ${pointExpr}
      )
      LIMIT 1;
    `;
  }

  const params =
    typeof withinDistanceMeters === "number"
      ? [lng, lat, withinDistanceMeters]
      : [lng, lat];

  const { rows } = await pool.query(sql, params);
  if (!rows || !rows.length) return null;
  return rows[0].properties || {};
}

/**
 * Main entry used by planner.controller.
 *
 * 1) Geocode the address via Google Maps
 * 2) Query PostGIS tables:
 *    - bcc_zoning
 *    - bcc_np_boundaries
 *    - bcc_np_precincts
 *    - bcc_flood_overland, bcc_flood_creek, bcc_flood_river
 *    - bcc_noise_corridor
 */
export async function fetchPlanningData({ address, lotPlan }) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error("[planner] GOOGLE_MAPS_API_KEY is not configured");
    throw new Error("Google Maps API key is required");
  }

  // 1) Geocode
  const { data } = await axios.get(GOOGLE_GEOCODE_URL, {
    params: {
      address,
      key: process.env.GOOGLE_MAPS_API_KEY,
    },
  });

  const result = data.results && data.results[0];
  if (!result) {
    throw new Error("Unable to geocode address");
  }

  const lat = result.geometry.location.lat;
  const lng = result.geometry.location.lng;

  // 2) Spatial lookups (run in parallel)
  let zoningProps = null;
  let npBoundaryProps = null;
  let npPrecinctProps = null;
  let floodOverlandProps = null;
  let floodCreekProps = null;
  let floodRiverProps = null;
  let noiseProps = null;

  try {
    const [zProps, npBProps, npPProps, fOverland, fCreek, fRiver, nProps] =
      await Promise.all([
        queryOne("bcc_zoning", lng, lat),
        queryOne("bcc_np_boundaries", lng, lat),
        queryOne("bcc_np_precincts", lng, lat),
        queryOne("bcc_flood_overland", lng, lat),
        queryOne("bcc_flood_creek", lng, lat),
        queryOne("bcc_flood_river", lng, lat),
        queryOne("bcc_noise_corridor", lng, lat, 50), // 50m buffer
      ]);

    zoningProps = zProps;
    npBoundaryProps = npBProps;
    npPrecinctProps = npPProps;
    floodOverlandProps = fOverland;
    floodCreekProps = fCreek;
    floodRiverProps = fRiver;
    noiseProps = nProps;
  } catch (err) {
    console.error(
      "[planner] PostGIS lookup failed:",
      (err && err.message) || err
    );
  }

  // 3) Interpret attributes

  // Zoning – try several possible property names before falling back to "Unknown"
  let zoningName =
    readProp(zoningProps, [
      "ZONE_NAME",
      "zone_name",
      "ZONE_DESC",
      "zone_desc",
      "ZONE",
      "zone",
    ]) || "Unknown zoning";

  const zoningCode = readProp(zoningProps, ["ZONE_CODE", "zone_code"]) || null;

  // Neighbourhood plan (boundary + precinct tables)
  const npNameBoundary =
    readProp(npBoundaryProps, ["NP_NAME", "np_name", "NAME", "name"]) || null;

  const npNamePrecinct =
    readProp(npPrecinctProps, ["NP_NAME", "np_name", "NAME", "name"]) || null;

  const npCodeBoundary =
    readProp(npBoundaryProps, ["NP_CODE", "np_code"]) || null;

  const npCodePrecinct =
    readProp(npPrecinctProps, ["NP_CODE", "np_code"]) || null;

  const npPrecinctName =
    readProp(npPrecinctProps, [
      "PRECINCT",
      "precinct",
      "NPP_NAME",
      "npp_name",
      "NPP_DESC",
      "npp_desc",
    ]) || null;

  const npPrecinctCode =
    readProp(npPrecinctProps, ["NPP_CODE", "npp_code"]) || null;

  const neighbourhoodPlan = npNamePrecinct || npNameBoundary || null;
  const neighbourhoodPlanCode = npCodePrecinct || npCodeBoundary || null;

  // Overlays
  const overlays = [];
  const rawFloodFeatures = [];
  let rawTransportNoiseFeature = null;
  let hasTransportNoiseCorridor = false;

  if (floodOverlandProps) {
    overlays.push({
      name: "Flood overlay – overland flow",
      code: "flood_overland_flow",
      severity:
        readProp(floodOverlandProps, [
          "HAZARD",
          "hazard",
          "SEVERITY",
          "severity",
        ]) || "overland flow",
    });
    rawFloodFeatures.push({
      source: "overland",
      properties: floodOverlandProps,
    });
  }

  if (floodCreekProps) {
    overlays.push({
      name: "Flood overlay – creek/waterway",
      code: "flood_creek_waterway",
      severity:
        readProp(floodCreekProps, [
          "HAZARD",
          "hazard",
          "SEVERITY",
          "severity",
        ]) || "creek/waterway flood planning area",
    });
    rawFloodFeatures.push({
      source: "creek_waterway",
      properties: floodCreekProps,
    });
  }

  if (floodRiverProps) {
    overlays.push({
      name: "Flood overlay – Brisbane River flood planning area",
      code: "flood_brisbane_river",
      severity:
        readProp(floodRiverProps, [
          "HAZARD",
          "hazard",
          "SEVERITY",
          "severity",
        ]) || "Brisbane River flood planning area",
    });
    rawFloodFeatures.push({
      source: "brisbane_river",
      properties: floodRiverProps,
    });
  }

  if (noiseProps) {
    hasTransportNoiseCorridor = true;
    overlays.push({
      name: "Transport noise corridor",
      code: "transport_noise_corridor",
      severity:
        readProp(noiseProps, ["CORRIDOR", "corridor", "LEVEL", "level"]) ||
        "near state-controlled road",
    });
    rawTransportNoiseFeature = {
      properties: noiseProps,
    };
  }

  return {
    geocode: {
      lat,
      lng,
      formattedAddress: result.formatted_address,
    },

    zoning: zoningName,
    zoningCode,

    neighbourhoodPlan,
    neighbourhoodPlanCode,
    neighbourhoodPlanPrecinct: npPrecinctName,
    neighbourhoodPlanPrecinctCode: npPrecinctCode,

    hasTransportNoiseCorridor,
    overlays,

    // raw debugging info (useful for future tuning / logs / admin UI)
    rawZoningFeature: zoningProps,
    rawNeighbourhoodPlanBoundary: npBoundaryProps,
    rawNeighbourhoodPlanPrecinct: npPrecinctProps,
    rawFloodFeatures,
    rawTransportNoiseFeature,
  };
}
