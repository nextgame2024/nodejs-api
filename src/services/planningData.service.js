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
 * Safe property reader for inconsistent upstream schemas.
 * Returns the first non-empty value found for the provided keys.
 */
function readProp(obj, keys) {
  if (!obj || !keys) return null;
  for (const k of keys) {
    if (!k) continue;
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
  }
  return null;
}

/**
 * Property parcel lookup – uses the bcc_property_parcels table.
 *
 * Goal: pick the *actual lot* (not an aggregated polygon, road parcel, easement, etc.)
 * even when the Google geocode lands on the street centreline.
 *
 * Strategy:
 *  - Candidate search within 120m (geography, after transforming geom to 4326).
 *  - Strongly filter known non-lot parcel types.
 *  - Prefer parcels that CONTAIN the geocode point.
 *  - Otherwise prefer parcels within a small tolerance (8m) and closest.
 *  - Prefer property_type H/U.
 *  - Prefer smaller area (m²) as a tie-breaker, with a soft penalty for very large polygons.
 *
 * Returns:
 *  - geometry: GeoJSON in EPSG:4326
 *  - point: an interior point (point-on-surface) in EPSG:4326 for subsequent overlay lookups
 */
async function queryPropertyParcel(lng, lat, lotPlan) {
  if (!pool) return null;

  const lotPlanText = (lotPlan || "").trim();

  const sql = `
    WITH pt AS (
      SELECT ${"ST_SetSRID(ST_MakePoint($1, $2), 4326)"} AS pt4326
    ),
    candidates AS (
      SELECT
        p.properties,
        ${"CASE WHEN ST_SRID(p.geom) IN (0,4326) THEN p.geom ELSE ST_Transform(p.geom,4326) END"} AS geom4326,
        ST_Contains(
          ${"CASE WHEN ST_SRID(p.geom) IN (0,4326) THEN p.geom ELSE ST_Transform(p.geom,4326) END"},
          pt.pt4326
        ) AS contains_pt,
        ST_DWithin(
          (${"CASE WHEN ST_SRID(p.geom) IN (0,4326) THEN p.geom ELSE ST_Transform(p.geom,4326) END"})::geography,
          pt.pt4326::geography,
          8
        ) AS within_8m,
        ST_DWithin(
          (${"CASE WHEN ST_SRID(p.geom) IN (0,4326) THEN p.geom ELSE ST_Transform(p.geom,4326) END"})::geography,
          pt.pt4326::geography,
          25
        ) AS within_25m,
        ST_Distance(
          (${"CASE WHEN ST_SRID(p.geom) IN (0,4326) THEN p.geom ELSE ST_Transform(p.geom,4326) END"})::geography,
          pt.pt4326::geography
        ) AS dist_m,
        ST_Area(
          (${"CASE WHEN ST_SRID(p.geom) IN (0,4326) THEN p.geom ELSE ST_Transform(p.geom,4326) END"})::geography
        ) AS area_m2,
        CASE
          WHEN $3 <> '' AND p.properties::text ILIKE ('%' || $3 || '%') THEN 0
          ELSE 1
        END AS lotplan_rank
      FROM bcc_property_parcels p, pt
      WHERE
        ST_DWithin(
          (${"CASE WHEN ST_SRID(p.geom) IN (0,4326) THEN p.geom ELSE ST_Transform(p.geom,4326) END"})::geography,
          pt.pt4326::geography,
          120
        )
        -- Defensive exclusions: avoid non-lot / transport / corridor parcels
        AND NOT (
          COALESCE(p.properties->>'parcel_typ_desc','') ILIKE ANY (ARRAY[
            '%road%',
            '%intersection%',
            '%rail%',
            '%easement%',
            '%reserve%',
            '%park%',
            '%water%',
            '%creek%',
            '%drain%',
            '%state%',
            '%council%',
            '%footpath%'
          ])
        )
    )
    SELECT
      properties,
      ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(
          ST_MakeValid(geom4326),
          0.000005
        )
      ) AS geom_geojson,
      ST_AsGeoJSON(
        ST_PointOnSurface(geom4326)
      ) AS point_geojson,
      contains_pt,
      within_8m,
      within_25m,
      dist_m,
      area_m2
    FROM candidates
    ORDER BY
      -- 1) If the geocode point falls inside multiple polygons, pick the *smallest* one (usually the lot).
      CASE WHEN contains_pt THEN 0 ELSE 1 END,
      -- 2) If the user provided a lot/plan hint, prefer matches.
      lotplan_rank,
      -- 3) Prefer residential property types when available.
      CASE WHEN properties->>'property_type' IN ('H','U') THEN 0 ELSE 1 END,
      -- 4) Otherwise allow a small distance tolerance (street-centre geocodes).
      CASE WHEN within_8m THEN 0 ELSE 1 END,
      -- 5) Avoid aggregated polygons unless we have no alternative.
      CASE WHEN area_m2 > 15000 THEN 1 ELSE 0 END,
      -- 6) Smallest area first, then closest.
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
      geometry: row.geom_geojson ? JSON.parse(row.geom_geojson) : null,
      point: row.point_geojson ? JSON.parse(row.point_geojson) : null,
      debug: {
        containsPoint: !!row.contains_pt,
        within8m: !!row.within_8m,
        within25m: !!row.within_25m,
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

/**
 * Main entry used by planner controller.
 *
 * 1) Geocode the address via Google Maps
 * 2) Query PostGIS tables:
 *    - bcc_zoning
 *    - bcc_np_boundaries
 *    - bcc_np_precincts
 *    - bcc_flood_overland, bcc_flood_creek, bcc_flood_river
 *    - bcc_noise_corridor
 *    - bcc_property_parcels (NEW – cadastral parcel)
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

  // Prefer an interior point from the cadastral parcel (better than street-centre geocode)
  const parcel = await queryPropertyParcel(lng, lat, lotPlan);
  const focusLat = parcel?.point?.coordinates?.[1] ?? lat;
  const focusLng = parcel?.point?.coordinates?.[0] ?? lng;

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

  let propertyParcelProps = null;
  let propertyParcelGeom = null;
  let propertyParcelDebug = null;

  try {
    const [zRow, npB, npP, fOverland, fCreek, fRiver, n] = await Promise.all([
      // ZONING via explicit SQL
      (async () => {
        if (!pool) return null;
        try {
          const { rows } = await pool.query(zoningSql, [focusLng, focusLat]);
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
      queryOne("bcc_np_boundaries", focusLng, focusLat),
      queryOne("bcc_np_precincts", focusLng, focusLat),
      queryOne("bcc_flood_overland", focusLng, focusLat),
      queryOne("bcc_flood_creek", focusLng, focusLat),
      queryOne("bcc_flood_river", focusLng, focusLat),
      queryOne("bcc_noise_corridor", focusLng, focusLat, 50), // 50m buffer for corridors

      // NEW: cadastral parcel (property boundary)
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

    propertyParcelProps = parcel?.properties || null;
    propertyParcelGeom = parcel?.geometry || null;
    propertyParcelDebug = parcel?.debug || null;
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

  // Property parcel interpretation
  const propertyParcel =
    propertyParcelProps || propertyParcelGeom
      ? {
          properties: propertyParcelProps || {},
          geometry: propertyParcelGeom || null,
          debug: propertyParcelDebug,
        }
      : null;

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

    // Cadastral parcel for the site (draw this as the green outline)
    siteParcelPolygon: propertyParcelGeom || null,
    propertyParcel,

    // raw debugging info (useful for future tuning / logs / admin UI)
    rawZoningFeature: zoningProps,
    rawNeighbourhoodPlanBoundary: npBoundaryProps,
    rawNeighbourhoodPlanPrecinct: npPrecinctProps,
    rawFloodFeatures,
    rawTransportNoiseFeature,
  };
}
