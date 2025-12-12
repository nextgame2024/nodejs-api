// src/services/planningData.service.js
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

/**
 * Explicit zoning lookup SQL.
 *
 * We extract the key attributes we care about from the bcc_zoning.properties
 * JSON so they are easy to read and debug.
 */
const zoningSql = `
  WITH site AS (
    SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom
  )
  SELECT
    (z.properties->>'zone_code')      AS zone_code,
    (z.properties->>'lvl1_zone')      AS lvl1_zone,
    (z.properties->>'lvl2_zone')      AS lvl2_zone,
    (z.properties->>'zone_prec_desc') AS zone_prec_desc,
    z.properties                      AS properties,
    ST_AsGeoJSON(
      ST_Simplify(z.geom, 0.0003)     -- keep payload light
    )                                 AS geom_geojson
  FROM bcc_zoning z, site s
  WHERE ST_Contains(z.geom, s.geom)
  LIMIT 1;
`;

/**
 * Safely read a property from a JSON object trying multiple keys.
 */
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
    sql = `
        SELECT
          properties,
          ST_AsGeoJSON(
            ST_Simplify(geom, 0.0003)
          ) AS geom_geojson
        FROM ${table}
        WHERE ST_DWithin(
          geom::geography,
          (${pointExpr})::geography,
          $3
        )
        LIMIT 1;
      `;
  } else {
    sql = `
        SELECT
          properties,
          ST_AsGeoJSON(
            ST_Simplify(geom, 0.0003)
          ) AS geom_geojson
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

  const row = rows[0];
  return {
    properties: row.properties || {},
    geometry: row.geom_geojson ? JSON.parse(row.geom_geojson) : null,
  };
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
  let zoningRow = null;
  let npBoundaryProps = null;
  let npPrecinctProps = null;
  let floodOverlandProps = null;
  let floodCreekProps = null;
  let floodRiverProps = null;
  let noiseProps = null;
  let npBoundaryGeom = null;
  let npPrecinctGeom = null;
  let floodOverlandGeom = null;
  let floodCreekGeom = null;
  let floodRiverGeom = null;
  let noiseGeom = null;

  try {
    const [zRow, npB, npP, fOverland, fCreek, fRiver, n] = await Promise.all([
      // ZONING via explicit SQL
      (async () => {
        if (!pool) return null;
        try {
          const { rows } = await pool.query(zoningSql, [lng, lat]);
          return rows[0] || null;
        } catch (err) {
          console.error(
            "[planner] zoning lookup failed:",
            (err && err.message) || err
          );
          return null;
        }
      })(),

      // Neighbourhood plan & overlays via generic helper
      queryOne("bcc_np_boundaries", lng, lat),
      queryOne("bcc_np_precincts", lng, lat),
      queryOne("bcc_flood_overland", lng, lat),
      queryOne("bcc_flood_creek", lng, lat),
      queryOne("bcc_flood_river", lng, lat),
      queryOne("bcc_noise_corridor", lng, lat, 50), // 50m buffer for corridors
    ]);

    zoningRow = zRow;
    npBoundaryProps = npB?.properties || null;
    npBoundaryGeom = npB?.geometry || null;

    npPrecinctProps = npP?.properties || null;
    npPrecinctGeom = npP?.geometry || null;

    floodOverlandProps = fOverland?.properties || null;
    floodOverlandGeom = fOverland?.geometry || null;

    floodCreekProps = fCreek?.properties || null;
    floodCreekGeom = fCreek?.geometry || null;

    floodRiverProps = fRiver?.properties || null;
    floodRiverGeom = fRiver?.geometry || null;

    noiseProps = n?.properties || null;
    noiseGeom = n?.geometry || null;
  } catch (err) {
    console.error(
      "[planner] PostGIS lookup failed:",
      (err && err.message) || err
    );
  }

  // 3) Interpret attributes

  // Zoning – prefer explicit columns from zoningRow, fall back to properties JSON
  const zoningProps = zoningRow ? zoningRow.properties || {} : null;

  const zoningPolygon =
    zoningRow && zoningRow.geom_geojson
      ? JSON.parse(zoningRow.geom_geojson)
      : null;

  let zoningName =
    readProp(zoningRow, ["zone_prec_desc"]) ||
    readProp(zoningProps, [
      "zone_prec_desc", // "LDR – Low density residential"
      "ZONE_PREC_DESC",
      "lvl2_zone", // "Low density residential"
      "LVL2_ZONE",
      "lvl1_zone", // "General residential"
      "LVL1_ZONE",
      "zone_name",
      "ZONE_NAME",
    ]) ||
    "Unknown zoning";

  const zoningCode =
    readProp(zoningRow, ["zone_code"]) ||
    readProp(zoningProps, ["zone_code", "ZONE_CODE"]) ||
    null;

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
  const overlayPolygons = [];
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

    if (floodOverlandGeom) {
      overlayPolygons.push({
        code: "flood_overland_flow",
        geometry: floodOverlandGeom,
      });
    }
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

    if (floodCreekGeom) {
      overlayPolygons.push({
        code: "flood_creek_waterway",
        geometry: floodCreekGeom,
      });
    }
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

    if (floodRiverGeom) {
      overlayPolygons.push({
        code: "flood_brisbane_river",
        geometry: floodRiverGeom,
      });
    }
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

    if (noiseGeom) {
      overlayPolygons.push({
        code: "transport_noise_corridor",
        geometry: noiseGeom,
      });
    }
  }

  return {
    geocode: {
      lat,
      lng,
      formattedAddress: result.formatted_address,
    },

    zoning: zoningName,
    zoningCode,
    zoningPolygon,

    neighbourhoodPlan,
    neighbourhoodPlanCode,
    neighbourhoodPlanPrecinct: npPrecinctName,
    neighbourhoodPlanPrecinctCode: npPrecinctCode,

    hasTransportNoiseCorridor,
    overlays,
    overlayPolygons,

    // raw debugging info (useful for future tuning / logs / admin UI)
    rawZoningFeature: zoningProps,
    rawNeighbourhoodPlanBoundary: npBoundaryProps,
    rawNeighbourhoodPlanPrecinct: npPrecinctProps,
    rawFloodFeatures,
    rawTransportNoiseFeature,
  };
}
