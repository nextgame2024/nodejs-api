// src/services/planningData_v2.service.js
//
// Version 2 planning lookup (map-ready geometries) based on the proven V1 PostGIS logic.
//
// Input: lat/lng (already resolved via Places API in the V2 flow)
// Output: zoning + neighbourhood plan metadata + map-ready GeoJSON geometries for:
//   - site parcel polygon
//   - zoning polygon
//   - overlay polygons (flood/noise/etc.)

import pool from "../config/db.js";

const _tableExistsCache = new Map();

async function tableExists(tableName) {
  if (!tableName) return false;
  if (_tableExistsCache.has(tableName)) return _tableExistsCache.get(tableName);

  try {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS regclass`, [
      tableName,
    ]);
    const ok = !!rows?.[0]?.regclass;
    _tableExistsCache.set(tableName, ok);
    return ok;
  } catch {
    _tableExistsCache.set(tableName, false);
    return false;
  }
}

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

/** Safely read a property from a JSON object trying multiple keys. */
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

function readPropCI(obj, keys) {
  if (!obj) return null;
  const keyMap = new Map();
  for (const k of Object.keys(obj)) keyMap.set(String(k).toLowerCase(), k);

  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      const v = obj[k];
      if (String(v).trim() !== "") return v;
    }

    const hit = keyMap.get(String(k).toLowerCase());
    if (hit && obj[hit] != null && String(obj[hit]).trim() !== "") return obj[hit];
  }

  return null;
}

function normalizeOverlayDetail(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/\s*sub-?category$/i, "");
  s = s.replace(/\s*sub-?categories$/i, "");
  return s.trim() || null;
}

function overlayDetail(props, keys, fallback = null) {
  const raw = readPropCI(props, keys);
  const normalized = normalizeOverlayDetail(raw);
  if (normalized) return normalized;
  return fallback || null;
}

function overlayName(base, detail) {
  return detail ? `${base} – ${detail}` : base;
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
 * - For polygon tables: uses ST_Covers(geom, point)
 * - For corridor/line tables: pass withinDistanceMeters to use ST_DWithin(...)
 *
 * Always returns GeoJSON geometry in EPSG:4326 (parsed object).
 */
async function queryOne(table, lng, lat, withinDistanceMeters) {
  if (!pool) return null;

  // NEW: skip missing tables cleanly
  if (!(await tableExists(table))) return null;

  const geom4326 = geomTo4326Sql("geom");
  const pointExpr = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";

  const predicate =
    typeof withinDistanceMeters === "number"
      ? `ST_DWithin((${geom4326})::geography, (${pointExpr})::geography, $3)`
      : `ST_Covers(ST_MakeValid(${geom4326}), ${pointExpr})`;

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
    if (!rows?.length) return null;
    const row = rows[0];
    return {
      properties: row.properties || {},
      geometry: safeJsonParse(row.geom_geojson),
    };
  } catch (err) {
    console.error(
      `[townplanner_v2] queryOne failed for ${table}:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * Spatial lookup for overlays that should be determined by parcel intersection (not just a point).
 * This is important for flood layers where a lot can be partially affected but a focus point
 * may fall outside the flood polygon.
 */
async function queryIntersects(table, parcelGeomGeoJSON) {
  if (!pool) return null;
  if (!parcelGeomGeoJSON) return null;

  // NEW: skip missing tables cleanly
  if (!(await tableExists(table))) return null;

  const geom4326 = geomTo4326Sql("geom");
  const parcelExpr = "ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)";

  const sql = `
    WITH parcel AS (
      SELECT ${parcelExpr} AS g
    )
    SELECT
      properties,
      ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(
          ST_MakeValid(${geom4326}),
          0.00001
        )
      ) AS geom_geojson
    FROM ${table}, parcel
    WHERE ST_Intersects(${geom4326}, parcel.g)
    ORDER BY
      ST_Area(ST_Intersection(${geom4326}, parcel.g)::geography) DESC NULLS LAST,
      ST_Area((${geom4326})::geography) DESC
    LIMIT 1;
  `;

  try {
    const { rows } = await pool.query(sql, [JSON.stringify(parcelGeomGeoJSON)]);
    if (!rows?.length) return null;
    const row = rows[0];
    return {
      properties: row.properties || {},
      geometry: safeJsonParse(row.geom_geojson),
    };
  } catch (err) {
    console.error(
      `[townplanner_v2] queryIntersects(${table}) failed:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * Property parcel lookup – uses the bcc_property_parcels table.
 *
 * Returns:
 *  - geometry: GeoJSON in EPSG:4326
 *  - point: interior point (point-on-surface) in EPSG:4326 (for robust downstream lookups)
 */
async function queryPropertyParcel(lng, lat, lotPlan) {
  if (!pool) return null;

  const lotPlanText = String(lotPlan || "").trim();
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
    if (!rows?.length) return null;
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
      "[townplanner_v2] property parcel lookup failed:",
      err?.message || err
    );
    return null;
  }
}

/**
 * Core planning lookup for V2.
 *
 * IMPORTANT: expects EPSG:4326 lng/lat.
 */
export async function fetchPlanningDataV2({ lng, lat, lotPlan = null }) {
  const safeLat = Number(lat);
  const safeLng = Number(lng);
  if (!Number.isFinite(safeLat) || !Number.isFinite(safeLng)) {
    throw new Error("Invalid lat/lng");
  }

  // 1) Parcel first, then use a point inside the lot for all other queries.
  const parcel = await queryPropertyParcel(safeLng, safeLat, lotPlan);
  const focusLat = parcel?.point?.coordinates?.[1] ?? safeLat;
  const focusLng = parcel?.point?.coordinates?.[0] ?? safeLng;
  const LINE_OVERLAY_DISTANCE_M = 40;

  // 2) Spatial lookups
  const floodPromises = parcel?.geometry
    ? [
        queryIntersects("bcc_flood_overland", parcel.geometry),
        queryIntersects("bcc_flood_creek", parcel.geometry),
        queryIntersects("bcc_flood_river", parcel.geometry),
      ]
    : [
        queryOne("bcc_flood_overland", focusLng, focusLat),
        queryOne("bcc_flood_creek", focusLng, focusLat),
        queryOne("bcc_flood_river", focusLng, focusLat),
      ];

  const [
    zoning,
    npB,
    npP,
    fOverland,
    fCreek,
    fRiver,
    noise,

    // NEW overlays / layers (ensure these table names match what your importer created)
    dwellingCharacter,
    traditionalCharacter,
    commercialCharacter,
    pre1911,
    heritageStateArea,
    airportHeight,
    airportOls,
    airportPansOps,
    lgipNetworkKey,
    bicycleNetwork,
    criticalInfrastructureMovementAssets,
    roadHierarchy,
    streetscapeHierarchy,
  ] = await Promise.all([
    queryOne("bcc_zoning", focusLng, focusLat),
    queryOne("bcc_np_boundaries", focusLng, focusLat),
    queryOne("bcc_np_precincts", focusLng, focusLat),
    ...floodPromises,
    queryOne("bcc_noise_corridor", focusLng, focusLat, 80),

    // Character / heritage overlays
    queryOne("bcc_dwelling_house_character", focusLng, focusLat),
    queryOne("bcc_traditional_building_character", focusLng, focusLat),
    queryOne("bcc_commercial_character_building", focusLng, focusLat),
    queryOne("bcc_pre_1911_building", focusLng, focusLat),
    queryOne("bcc_heritage_state_heritage_area", focusLng, focusLat),

    // Airport environs overlays
    queryOne("bcc_airport_height_restriction", focusLng, focusLat),
    queryOne("bcc_airport_ols_boundary", focusLng, focusLat),
    queryOne("bcc_airport_pans_ops", focusLng, focusLat),

    // Services / infrastructure indicator (LGIP network key)
    queryOne("bcc_lgip_network_key", focusLng, focusLat),

    // Networks / hierarchy overlays (often line-based)
    queryOne(
      "bcc_bicycle_network_overlay",
      focusLng,
      focusLat,
      LINE_OVERLAY_DISTANCE_M
    ),
    queryOne(
      "bcc_critical_infrastructure_movement_assets",
      focusLng,
      focusLat
    ),
    queryOne("bcc_road_hierarchy", focusLng, focusLat, LINE_OVERLAY_DISTANCE_M),
    queryOne(
      "bcc_streetscape_hierarchy",
      focusLng,
      focusLat,
      LINE_OVERLAY_DISTANCE_M
    ),
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
    readProp(npPrecinctProps, [
      "NP_NAME",
      "np_name",
      "NAME",
      "name",
      "LP",
      "lp",
    ]) ||
    readProp(npBoundaryProps, [
      "NP_NAME",
      "np_name",
      "NAME",
      "name",
      "LP",
      "lp",
    ]) ||
    null;

  const neighbourhoodPlanCode =
    readProp(npPrecinctProps, ["NP_CODE", "np_code", "LP_CODE", "lp_code"]) ||
    readProp(npBoundaryProps, ["NP_CODE", "np_code", "LP_CODE", "lp_code"]) ||
    null;

  const npPrecinctName =
    readProp(npPrecinctProps, [
      "PRECINCT",
      "precinct",
      "NPP_NAME",
      "npp_name",
      "NPP_DESC",
      "npp_desc",
      "LP_PREC",
      "lp_prec",
    ]) || null;

  const npPrecinctCode =
    readProp(npPrecinctProps, [
      "NPP_CODE",
      "npp_code",
      "LP_PREC_CODE",
      "lp_prec_code",
    ]) || null;

  // 3) Overlays
  const overlays = [];
  const overlayPolygons = [];

  const pushOverlay = (props, geom, def) => {
    if (!props) return;
    overlays.push(def);
    if (geom) overlayPolygons.push({ code: def.code, geometry: geom });
  };

  const overlayDetailKeys = [
    "OVL2_DESC",
    "ovl2_desc",
    "OVL_DESC",
    "ovl_desc",
    "SUBCATEGORY",
    "sub_category",
    "SUB_CAT",
    "sub_cat",
    "CATEGORY",
    "category",
    "TYPE",
    "type",
    "CLASS",
    "class",
    "DESCRIPTION",
    "description",
    "DESC",
    "desc",
  ];
  const bicycleKeys = overlayDetailKeys.concat([
    "ROUTE",
    "route",
    "ROUTE_TYPE",
    "route_type",
    "NETWORK",
    "network",
  ]);
  const criticalKeys = overlayDetailKeys.concat([
    "PLANNING_AREA",
    "planning_area",
    "AREA",
    "area",
    "ASSET",
    "asset",
    "INFRASTRUCTURE",
    "infrastructure",
    "MOVEMENT",
    "movement",
  ]);
  const roadHierarchyKeys = overlayDetailKeys.concat([
    "ROAD_HIERARCHY",
    "road_hierarchy",
    "ROAD_TYPE",
    "road_type",
    "ROAD_CLASS",
    "road_class",
    "HIERARCHY",
    "hierarchy",
  ]);
  const streetscapeKeys = overlayDetailKeys.concat([
    "STREETSCAPE",
    "streetscape",
    "HIERARCHY",
    "hierarchy",
  ]);

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

  // NEW: push character / heritage / airport overlays
  pushOverlay(dwellingCharacter?.properties, dwellingCharacter?.geometry, {
    name: "Dwelling house character overlay",
    code: "character_dwelling_house",
    severity: "mapped overlay",
  });

  pushOverlay(
    traditionalCharacter?.properties,
    traditionalCharacter?.geometry,
    {
      name: "Traditional building character overlay",
      code: "character_traditional_building",
      severity: "mapped overlay",
    }
  );

  pushOverlay(commercialCharacter?.properties, commercialCharacter?.geometry, {
    name: "Commercial character building overlay",
    code: "character_commercial_building",
    severity: "mapped overlay",
  });

  pushOverlay(pre1911?.properties, pre1911?.geometry, {
    name: "Pre-1911 building overlay",
    code: "overlay_pre_1911",
    severity: "mapped overlay",
  });

  pushOverlay(heritageStateArea?.properties, heritageStateArea?.geometry, {
    name: "Heritage overlay – State heritage area",
    code: "overlay_state_heritage_area",
    severity: "mapped overlay",
  });

  pushOverlay(airportHeight?.properties, airportHeight?.geometry, {
    name: "Airport environs overlay – Height restriction zone",
    code: "overlay_airport_height",
    severity: "mapped overlay",
  });

  pushOverlay(airportOls?.properties, airportOls?.geometry, {
    name: "Airport environs overlay – OLS boundary",
    code: "overlay_airport_ols",
    severity: "mapped overlay",
  });

  const pansDetail = overlayDetail(
    airportPansOps?.properties,
    overlayDetailKeys,
    "Procedures for air navigation surfaces (PANS)"
  );
  pushOverlay(airportPansOps?.properties, airportPansOps?.geometry, {
    name: overlayName("Airport environs overlay", pansDetail),
    code: "overlay_airport_pans",
    severity: pansDetail || "mapped overlay",
  });

  const bicycleDetail = overlayDetail(bicycleNetwork?.properties, bicycleKeys);
  pushOverlay(bicycleNetwork?.properties, bicycleNetwork?.geometry, {
    name: overlayName("Bicycle network overlay", bicycleDetail),
    code: "overlay_bicycle_network",
    severity: bicycleDetail || "mapped overlay",
  });

  const criticalDetail = overlayDetail(
    criticalInfrastructureMovementAssets?.properties,
    criticalKeys
  );
  pushOverlay(
    criticalInfrastructureMovementAssets?.properties,
    criticalInfrastructureMovementAssets?.geometry,
    {
      name: overlayName(
        "Critical infrastructure and movement areas overlay",
        criticalDetail
      ),
      code: "overlay_critical_infrastructure_movement",
      severity: criticalDetail || "mapped overlay",
    }
  );

  const roadDetail = overlayDetail(roadHierarchy?.properties, roadHierarchyKeys);
  pushOverlay(roadHierarchy?.properties, roadHierarchy?.geometry, {
    name: overlayName("Road hierarchy overlay", roadDetail),
    code: "overlay_road_hierarchy",
    severity: roadDetail || "mapped overlay",
  });

  const streetscapeDetail = overlayDetail(
    streetscapeHierarchy?.properties,
    streetscapeKeys
  );
  pushOverlay(streetscapeHierarchy?.properties, streetscapeHierarchy?.geometry, {
    name: overlayName("Streetscape hierarchy overlay", streetscapeDetail),
    code: "overlay_streetscape_hierarchy",
    severity: streetscapeDetail || "mapped overlay",
  });

  // Services meta for reporting (not necessarily a map overlay page)
  const rawLgipNetworkKey = lgipNetworkKey?.properties || null;

  return {
    // Geocode-like object for consistency (but values are already provided)
    geocode: {
      lat: safeLat,
      lng: safeLng,
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

    // Optional raw debug (useful for admin/logging)
    rawZoningFeature: zoningProps,
    rawNeighbourhoodPlanBoundary: npBoundaryProps,
    rawNeighbourhoodPlanPrecinct: npPrecinctProps,

    // NEW raw overlay fields (for PDF/Gemini data contract)
    rawCharacterDwelling: dwellingCharacter?.properties || null,
    rawCharacterTraditional: traditionalCharacter?.properties || null,
    rawCharacterCommercial: commercialCharacter?.properties || null,
    rawPre1911: pre1911?.properties || null,
    rawHeritageStateArea: heritageStateArea?.properties || null,
    rawAirportHeight: airportHeight?.properties || null,
    rawAirportOls: airportOls?.properties || null,
    rawAirportPansOps: airportPansOps?.properties || null,
    rawLgipNetworkKey,
    rawBicycleNetwork: bicycleNetwork?.properties || null,
    rawCriticalInfrastructureMovementAssets:
      criticalInfrastructureMovementAssets?.properties || null,
    rawRoadHierarchy: roadHierarchy?.properties || null,
    rawStreetscapeHierarchy: streetscapeHierarchy?.properties || null,
  };
}
