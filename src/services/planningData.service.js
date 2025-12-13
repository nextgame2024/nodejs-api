// src/services/planningData.service.js

import axios from "axios";
import pgPkg from "pg";

const { Pool } = pgPkg;

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

// Prefer DATABASE_URL; fall back to DB_* env vars if you use those.
const connectionString =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST &&
    `postgres://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(
      process.env.DB_PASSWORD
    )}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${
      process.env.DB_DATABASE
    }`);

if (!connectionString) {
  console.error(
    "[planner] DATABASE_URL or DB_* env vars are required for PostGIS lookups"
  );
}

const pool = connectionString ? new Pool({ connectionString }) : null;

function safeJsonParse(maybeJson) {
  if (!maybeJson) return null;
  if (typeof maybeJson === "object") return maybeJson;
  if (typeof maybeJson === "string") {
    try {
      return JSON.parse(maybeJson);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Safely read a property from a JSON object trying multiple keys.
 */
function readProp(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      const v = obj[k];
      if (String(v).trim() !== "") return v;
    }
  }
  return null;
}

/**
 * Convert table geom to EPSG:4326 defensively.
 * - If SRID is 4326: keep
 * - If SRID is 0: assume 4326 (best-effort)
 * - Else: transform to 4326
 */
function geomTo4326Sql(geomCol = "geom") {
  return `
    CASE
      WHEN ST_SRID(${geomCol}) = 4326 THEN ${geomCol}
      WHEN ST_SRID(${geomCol}) = 0 THEN ST_SetSRID(${geomCol}, 4326)
      ELSE ST_Transform(${geomCol}, 4326)
    END
  `;
}

/**
 * Generic spatial lookup helper.
 *
 * - For polygon tables: uses ST_Contains(geom4326, point4326)
 * - For corridor/line tables: pass withinDistanceMeters to use ST_DWithin(...)
 *
 * Always returns GeoJSON geometry in EPSG:4326 (parsed object).
 */
async function queryOne(table, lng, lat, withinDistanceMeters) {
  if (!pool) return null;

  // NOTE: table is always a fixed internal constant in this app.
  const geom4326 = geomTo4326Sql("geom");
  const pointExpr = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";

  const predicate =
    typeof withinDistanceMeters === "number"
      ? `ST_DWithin((${geom4326})::geography, (${pointExpr})::geography, $3)`
      : `ST_Contains(${geom4326}, ${pointExpr})`;

  const orderBy =
    typeof withinDistanceMeters === "number"
      ? `ST_Distance((${geom4326})::geography, (${pointExpr})::geography)`
      : `ST_Area((${geom4326})::geography)`;

  const sql = `
    SELECT
      properties,
      ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(
          ST_MakeValid(${geom4326}),
          0.00001
        )
      ) AS geom_geojson
    FROM ${table}
    WHERE ${predicate}
    ORDER BY ${orderBy}
    LIMIT 1;
  `;

  const params =
    typeof withinDistanceMeters === "number"
      ? [lng, lat, withinDistanceMeters]
      : [lng, lat];

  try {
    const { rows } = await pool.query(sql, params);
    if (!rows || !rows.length) return null;

    const row = rows[0];
    return {
      properties: row.properties || {},
      geometry: safeJsonParse(row.geom_geojson),
    };
  } catch (err) {
    console.error(
      `[planner] queryOne failed for ${table}:`,
      (err && err.message) || err
    );
    return null;
  }
}

/**
 * Property parcel lookup – uses the bcc_property_parcels table.
 *
 * Goal: pick the *actual cadastral lot* (not an aggregated polygon, road parcel, easement, etc.)
 * even when the Google geocode lands on the street centreline.
 *
 * Strategy (ranked tiers):
 *  0) contains point AND area <= 8,000m²
 *  1) contains point (any size)
 *  2) within 25m AND area <= 8,000m²
 *  3) within 25m (any size)
 *  4) within 120m AND area <= 8,000m²
 *  5) within 120m (any size)
 *
 * Within the tier, prefer:
 *  - lotPlan text match (if provided)
 *  - property_type H/U
 *  - smaller area (m²)
 *  - closer distance
 *
 * Returns:
 *  - geometry: GeoJSON in EPSG:4326 (parsed object)
 *  - point: interior point (point-on-surface) in EPSG:4326
 */
async function queryPropertyParcel(lng, lat, lotPlan) {
  if (!pool) return null;

  const lotPlanText = (lotPlan || "").trim();
  const geom4326 = geomTo4326Sql("p.geom");

  const sql = `
    WITH pt AS (
      SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS pt4326
    ),
    candidates AS (
      SELECT
        p.properties,
        ${geom4326} AS geom4326,
        ST_Contains(${geom4326}, pt.pt4326) AS contains_pt,
        ST_DWithin((${geom4326})::geography, pt.pt4326::geography, 25) AS within_25m,
        ST_DWithin((${geom4326})::geography, pt.pt4326::geography, 120) AS within_120m,
        ST_Distance((${geom4326})::geography, pt.pt4326::geography) AS dist_m,
        ST_Area((${geom4326})::geography) AS area_m2,
        CASE
          WHEN $3 <> '' AND p.properties::text ILIKE ('%' || $3 || '%') THEN 0
          ELSE 1
        END AS lotplan_rank
      FROM bcc_property_parcels p, pt
      WHERE
        ST_DWithin((${geom4326})::geography, pt.pt4326::geography, 120)
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%road%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%intersection%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%rail%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%easement%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%reserve%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%park%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%water%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%creek%'
        AND COALESCE(p.properties->>'parcel_typ_desc','') NOT ILIKE '%drain%'
    )
    SELECT
      properties,
      ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(
          ST_MakeValid(geom4326),
          0.000005
        )
      ) AS geom_geojson,
      ST_AsGeoJSON(ST_PointOnSurface(geom4326)) AS point_geojson,
      contains_pt,
      within_25m,
      within_120m,
      dist_m,
      area_m2
    FROM candidates
    ORDER BY
      CASE
        WHEN contains_pt AND area_m2 <= 8000 THEN 0
        WHEN contains_pt THEN 1
        WHEN within_25m AND area_m2 <= 8000 THEN 2
        WHEN within_25m THEN 3
        WHEN within_120m AND area_m2 <= 8000 THEN 4
        ELSE 5
      END,
      lotplan_rank,
      CASE WHEN properties->>'property_type' IN ('H','U') THEN 0 ELSE 1 END,
      area_m2,
      dist_m
    LIMIT 1;
  `;

  try {
    const { rows } = await pool.query(sql, [lng, lat, lotPlanText]);
    if (!rows || !rows.length) return null;

    const row = rows[0];
    return {
      properties: row.properties || {},
      geometry: safeJsonParse(row.geom_geojson),
      point: safeJsonParse(row.point_geojson),
      debug: {
        containsPoint: !!row.contains_pt,
        within25m: !!row.within_25m,
        within120m: !!row.within_120m,
        distM: row.dist_m != null ? Number(row.dist_m) : null,
        areaM2: row.area_m2 != null ? Number(row.area_m2) : null,
      },
    };
  } catch (err) {
    console.error(
      "[planner] property parcel lookup failed:",
      (err && err.message) || err
    );
    return null;
  }
}

export async function fetchPlanningData({ address, lotPlan }) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error("[planner] GOOGLE_MAPS_API_KEY is not configured");
    throw new Error("Google Maps API key is required");
  }

  // 1) Geocode address
  const { data } = await axios.get(GOOGLE_GEOCODE_URL, {
    params: {
      address,
      key: process.env.GOOGLE_MAPS_API_KEY,
    },
  });

  const geocodeResult = data.results && data.results[0];
  if (!geocodeResult) throw new Error("Unable to geocode address");

  const lat = geocodeResult.geometry.location.lat;
  const lng = geocodeResult.geometry.location.lng;

  // 2) Parcel first, then use a point inside the lot for all other queries.
  const parcel = await queryPropertyParcel(lng, lat, lotPlan);
  const focusLat = parcel?.point?.coordinates?.[1] ?? lat;
  const focusLng = parcel?.point?.coordinates?.[0] ?? lng;

  // 3) Spatial lookups
  const [zoning, npB, npP, fOverland, fCreek, fRiver, noise] =
    await Promise.all([
      queryOne("bcc_zoning", focusLng, focusLat),
      queryOne("bcc_np_boundaries", focusLng, focusLat),
      queryOne("bcc_np_precincts", focusLng, focusLat),
      queryOne("bcc_flood_overland", focusLng, focusLat),
      queryOne("bcc_flood_creek", focusLng, focusLat),
      queryOne("bcc_flood_river", focusLng, focusLat),
      queryOne("bcc_noise_corridor", focusLng, focusLat, 80), // corridor buffer (meters)
    ]);

  const zoningProps = zoning?.properties || null;
  const zoningPolygon = zoning?.geometry || null;

  const zoningName =
    readProp(zoningProps, [
      "zone_prec_desc",
      "ZONE_PREC_DESC",
      "lvl2_zone",
      "LVL2_ZONE",
      "lvl1_zone",
      "LVL1_ZONE",
      "zone_name",
      "ZONE_NAME",
      "ZONE_DESC",
      "zone_desc",
    ]) || "Unknown zoning";

  const zoningCode =
    readProp(zoningProps, ["zone_code", "ZONE_CODE", "ZONE", "zone"]) || null;

  const npBoundaryProps = npB?.properties || null;
  const npPrecinctProps = npP?.properties || null;

  const neighbourhoodPlan =
    readProp(npPrecinctProps, ["NP_NAME", "np_name", "NAME", "name"]) ||
    readProp(npBoundaryProps, ["NP_NAME", "np_name", "NAME", "name"]) ||
    null;

  const neighbourhoodPlanCode =
    readProp(npPrecinctProps, ["NP_CODE", "np_code"]) ||
    readProp(npBoundaryProps, ["NP_CODE", "np_code"]) ||
    null;

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

  // Overlays
  const overlays = [];
  const overlayPolygons = [];

  const pushOverlay = (props, geom, def) => {
    if (!props) return;
    overlays.push(def);
    if (geom) overlayPolygons.push({ code: def.code, geometry: geom });
  };

  pushOverlay(fOverland?.properties, fOverland?.geometry, {
    name: "Flood overlay – overland flow",
    code: "flood_overland_flow",
    severity:
      readProp(fOverland?.properties, [
        "HAZARD",
        "hazard",
        "SEVERITY",
        "severity",
      ]) || "overland flow",
  });

  pushOverlay(fCreek?.properties, fCreek?.geometry, {
    name: "Flood overlay – creek/waterway",
    code: "flood_creek_waterway",
    severity:
      readProp(fCreek?.properties, [
        "HAZARD",
        "hazard",
        "SEVERITY",
        "severity",
      ]) || "creek/waterway flood planning area",
  });

  pushOverlay(fRiver?.properties, fRiver?.geometry, {
    name: "Flood overlay – Brisbane River flood planning area",
    code: "flood_brisbane_river",
    severity:
      readProp(fRiver?.properties, [
        "HAZARD",
        "hazard",
        "SEVERITY",
        "severity",
      ]) || "Brisbane River flood planning area",
  });

  let hasTransportNoiseCorridor = false;
  if (noise?.properties) {
    hasTransportNoiseCorridor = true;
    overlays.push({
      name: "Transport noise corridor",
      code: "transport_noise_corridor",
      severity:
        readProp(noise?.properties, [
          "CORRIDOR",
          "corridor",
          "LEVEL",
          "level",
        ]) || "near state-controlled road",
    });
    if (noise?.geometry) {
      overlayPolygons.push({
        code: "transport_noise_corridor",
        geometry: noise.geometry,
      });
    }
  }

  return {
    geocode: {
      lat,
      lng,
      formattedAddress: geocodeResult.formatted_address,
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

    // Cadastral parcel for the site (draw this as the green outline)
    siteParcelPolygon: parcel?.geometry || null,
    propertyParcel: parcel
      ? {
          properties: parcel.properties || {},
          geometry: parcel.geometry || null,
          debug: parcel.debug || null,
        }
      : null,

    // Raw debug – optional for logs/admin UI
    rawZoningFeature: zoningProps,
    rawNeighbourhoodPlanBoundary: npBoundaryProps,
    rawNeighbourhoodPlanPrecinct: npPrecinctProps,
  };
}
