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

export const PLANNING_SNAPSHOT_VERSION = "TPR-PLANNING-V2-2026-04-13.2";

const _tableExistsCache = new Map();
const VEGETATION_LAYER_CODE =
  "state_mapping_sara_regulated_vegetation_management_map";
const VEGETATION_ARCGIS_QUERY_URL =
  process.env.STATE_MAPPING_VEGETATION_ARCGIS_QUERY_URL ||
  "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Biota/VegetationManagement/MapServer/109/query";

const DAMS_STATE_TRANSPORT_LAYERS = [
  {
    table: "qld_dams_state_transport_25m_railway_corridor",
    code: "dams_state_transport_25m_railway_corridor",
    detail: "Area within 25m of a railway corridor",
  },
  {
    table: "qld_dams_state_transport_25m_state_controlled_road",
    code: "dams_state_transport_25m_state_controlled_road",
    detail: "Area within 25m of a State-controlled road",
  },
  {
    table: "qld_dams_state_transport_25m_busway_corridor",
    code: "dams_state_transport_25m_busway_corridor",
    detail: "Area within 25m of a busway corridor",
  },
  {
    table: "qld_dams_state_transport_25m_light_rail_corridor",
    code: "dams_state_transport_25m_light_rail_corridor",
    detail: "Area within 25m of a light rail corridor",
  },
  {
    table: "qld_dams_state_transport_future_busway_corridor",
    code: "dams_state_transport_future_busway_corridor",
    detail: "Future busway corridor",
  },
  {
    table: "qld_dams_state_transport_busway_corridor",
    code: "dams_state_transport_busway_corridor",
    detail: "Busway corridor",
  },
  {
    table: "qld_dams_state_transport_future_light_rail_corridor",
    code: "dams_state_transport_future_light_rail_corridor",
    detail: "Future light rail corridor",
  },
  {
    table: "qld_dams_state_transport_light_rail_corridor",
    code: "dams_state_transport_light_rail_corridor",
    detail: "Light rail corridor",
  },
  {
    table: "qld_dams_state_transport_state_controlled_road",
    code: "dams_state_transport_state_controlled_road",
    detail: "State-controlled road",
  },
  {
    table: "qld_dams_state_transport_future_state_controlled_road",
    code: "dams_state_transport_future_state_controlled_road",
    detail: "Future State-controlled road",
  },
  {
    table: "qld_dams_state_transport_future_railway_corridor",
    code: "dams_state_transport_future_railway_corridor",
    detail: "Future railway corridor",
  },
  {
    table: "qld_dams_state_transport_railway_corridor",
    code: "dams_state_transport_railway_corridor",
    detail: "Railway corridor",
  },
];

const STATE_MAPPING_CONSIDERATION_LAYERS = [
  {
    table: "qld_state_mapping_seq_regional_plan_land_use_categories",
    code: "state_mapping_sara_seq_regional_plan_land_use_categories",
    sectionTitle: "SARA DA Mapping",
    subsectionTitle: "SEQ Regional Plan Triggers",
    name: "SEQ Regional Plan land use categories",
    detailKeys: ["RLUC2023", "RLUC", "CATEGORY", "TYPE", "CLASS"],
    fallbackDetail: "Mapped area",
    source: "Queensland DAMS (SARA/SARA_Data layer 51)",
    contextDistanceMeters: 1200,
    clipDistanceMeters: 1200,
  },
  {
    table: "qld_state_mapping_water_resource_planning_area_boundaries",
    code: "state_mapping_sara_water_resource_planning_area_boundaries",
    sectionTitle: "SARA DA Mapping",
    subsectionTitle: "Water resources",
    name: "Water resources planning area boundaries",
    detailKeys: ["WRPREGION", "REGION", "NAME", "DESCRIPTION"],
    fallbackDetail: "Mapped area",
    source: "Queensland DAMS (SARA/SARA_Data layer 9)",
    contextDistanceMeters: 1400,
    clipDistanceMeters: 1400,
  },
  {
    table: "qld_state_mapping_regulated_vegetation_management_map",
    code: "state_mapping_sara_regulated_vegetation_management_map",
    sectionTitle: "SARA DA Mapping",
    subsectionTitle: "Native vegetation clearing",
    name: "Regulated vegetation management map",
    detailKeys: ["rvm_cat", "RVM_CAT", "CATEGORY", "CLASS"],
    fallbackDetail: "Mapped area",
    source: "Queensland Vegetation Management (Biota/VegetationManagement layer 109)",
    contextDistanceMeters: 900,
    clipDistanceMeters: 900,
  },
  {
    table: "qld_state_mapping_spp_flood_hazard_lg_flood_mapping_area",
    code: "state_mapping_spp_flood_hazard_local_government",
    sectionTitle: "SPP Assessment Benchmark Mapping",
    subsectionTitle: "Natural hazards risk and resilience",
    name: "Flood hazard area - local government flood mapping area",
    detailKeys: ["LGA", "LOCAL_GOVERNMENT", "NAME", "DESCRIPTION"],
    fallbackDetail: "Mapped area",
    source: "Queensland DAMS (SPP/SPP_Data layer 62)",
    contextDistanceMeters: 1000,
    clipDistanceMeters: 1000,
  },
  {
    table: "qld_state_mapping_rpi_priority_living_area",
    code: "state_mapping_rpi_priority_living_area",
    sectionTitle: "Other State Planning matters",
    subsectionTitle: "Areas of Regional Interest",
    name: "Priority living area",
    detailKeys: ["RPITYPE", "NAME", "REGION", "STATUS"],
    fallbackDetail: "Mapped area",
    source: "Queensland Regional Planning Interests (RPI layer 5)",
    contextDistanceMeters: 1200,
    clipDistanceMeters: 1200,
  },
];

const ACID_SULFATE_OVERLAY_LAYERS = [
  {
    table: "bcc_potential_actual_acid_sulfate_soils",
    detail: "Potential and actual acid sulfate soils",
  },
  {
    table: "bcc_potential_actual_acid_sulfate_soils_below_5m_ahd",
    detail: "Land at or below 5m AHD",
  },
  {
    table: "bcc_potential_actual_acid_sulfate_soils_5m_to_20m_ahd",
    detail: "Land above 5m AHD and below 20m AHD",
  },
];

async function tableExists(tableName) {
  if (!tableName) return false;
  if (_tableExistsCache.has(tableName)) return true;

  try {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS regclass`, [
      tableName,
    ]);
    const ok = !!rows?.[0]?.regclass;
    if (ok) _tableExistsCache.set(tableName, true);
    return ok;
  } catch {
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

function formatStateMappingDetail(layerCode, rawDetail, props = {}) {
  const code = String(layerCode || "").trim();
  const detail = String(rawDetail || "").trim();
  if (!detail) return null;

  if (code === "state_mapping_sara_regulated_vegetation_management_map") {
    const normalized = detail.toUpperCase();
    if (normalized === "A")
      return "Category A on the regulated vegetation management map.";
    if (normalized === "B")
      return "Category B on the regulated vegetation management map.";
    if (normalized === "C")
      return "Category C on the regulated vegetation management map.";
    if (normalized === "R")
      return "Category R on the regulated vegetation management map.";
    if (normalized === "X")
      return "Category X on the regulated vegetation management map.";
    return `${detail} on the regulated vegetation management map.`;
  }

  if (code === "state_mapping_sara_water_resource_planning_area_boundaries") {
    return `${detail} water resources planning area boundary.`;
  }

  if (code === "state_mapping_spp_flood_hazard_local_government") {
    const lga = readPropCI(props, ["LGA", "LOCAL_GOVERNMENT", "NAME"]);
    if (lga) return `Local government flood mapping area (${lga}).`;
    return "Local government flood mapping area.";
  }

  if (code === "state_mapping_rpi_priority_living_area") {
    const regionRaw = readPropCI(props, ["REGION"]);
    const region = String(regionRaw || "").trim();
    if (region) {
      const regionLabel = /south\s*east\s*queensland/i.test(region)
        ? "SEQ"
        : region;
      return `Priority living area (${regionLabel}).`;
    }
    const areaName = readPropCI(props, ["NAME"]);
    if (areaName) return `Priority living area (${areaName}).`;
    return "Priority living area.";
  }

  return detail;
}

function buildStateMappingDetail(layer, props) {
  const rawDetail = readPropCI(props, layer?.detailKeys || []);
  const formatted = formatStateMappingDetail(layer?.code, rawDetail, props);
  if (formatted) return formatted;
  return String(layer?.fallbackDetail || "Mapped area").trim();
}

async function queryVegetationCategoryArcgis({ lng, lat }) {
  if (!Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) return null;
  const geometry = {
    x: Number(lng),
    y: Number(lat),
    spatialReference: { wkid: 4326 },
  };
  const params = new URLSearchParams({
    f: "pjson",
    geometry: JSON.stringify(geometry),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "rvm_cat,map_no,objectid",
    returnGeometry: "false",
  });

  try {
    const resp = await fetch(`${VEGETATION_ARCGIS_QUERY_URL}?${params.toString()}`, {
      headers: {
        Referer:
          process.env.DAMS_REFERER || "https://sppims-dams.dsdilgp.qld.gov.au/",
        Origin:
          process.env.DAMS_ORIGIN || "https://sppims-dams.dsdilgp.qld.gov.au",
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const attrs = data?.features?.[0]?.attributes || null;
    if (!attrs || typeof attrs !== "object") return null;
    const cat = readPropCI(attrs, ["rvm_cat", "RVM_CAT"]);
    if (!cat) return null;
    return {
      ...attrs,
      __source: "qld_vegetation_management_arcgis_fallback",
    };
  } catch {
    return null;
  }
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
async function queryOne(table, lng, lat, withinDistanceMeters, options = {}) {
  if (!pool) return null;

  // NEW: skip missing tables cleanly
  if (!(await tableExists(table))) return null;

  // Backward-compatible overload:
  // queryOne(table, lng, lat, { preferLargestArea: true })
  if (
    withinDistanceMeters &&
    typeof withinDistanceMeters === "object" &&
    !Array.isArray(withinDistanceMeters)
  ) {
    options = withinDistanceMeters;
    withinDistanceMeters = undefined;
  }

  const preferLargestArea = !!options?.preferLargestArea;

  const geom4326 = geomTo4326Sql("geom");
  const pointExpr = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";

  const predicate =
    typeof withinDistanceMeters === "number"
      ? `ST_DWithin((${geom4326})::geography, (${pointExpr})::geography, $3)`
      : `ST_Covers(ST_MakeValid(${geom4326}), ${pointExpr})`;

  const orderBy =
    typeof withinDistanceMeters === "number"
      ? `ST_Distance((${geom4326})::geography, (${pointExpr})::geography)`
      : `ST_Area((${geom4326})::geography) ${preferLargestArea ? "DESC" : "ASC"}`;

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
 * Build a broader zoning geometry context around the site by merging nearby
 * polygons with the same zone key. This avoids rendering only a tiny zoning
 * fragment when the zone is split by road/reserve boundaries.
 */
async function queryZoningContextGeometry({
  table = "bcc_zoning",
  lng,
  lat,
  zoneCode = null,
  zoneName = null,
  withinDistanceMeters = 320,
}) {
  if (!pool) return null;
  if (!(await tableExists(table))) return null;

  const codeNorm = String(zoneCode || "")
    .trim()
    .toLowerCase();
  const nameNorm = String(zoneName || "")
    .trim()
    .toLowerCase();
  const nameCoreNorm = nameNorm.replace(/^[a-z0-9]+\s*-\s*/, "").trim();
  if (!codeNorm && !nameNorm) return null;

  const geom4326 = geomTo4326Sql("geom");
  const pointExpr = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";

  const codeExpr = `
    lower(
      coalesce(
        nullif(properties->>'zone_code',''),
        nullif(properties->>'ZONE_CODE',''),
        nullif(properties->>'zone',''),
        nullif(properties->>'ZONE','')
      )
    )
  `;
  const nameExpr = `
    lower(
      coalesce(
        nullif(properties->>'zone_prec_desc',''),
        nullif(properties->>'ZONE_PREC_DESC',''),
        nullif(properties->>'zone_desc',''),
        nullif(properties->>'ZONE_DESC',''),
        nullif(properties->>'zone_name',''),
        nullif(properties->>'ZONE_NAME',''),
        nullif(properties->>'lvl2_zone',''),
        nullif(properties->>'LVL2_ZONE',''),
        nullif(properties->>'lvl1_zone',''),
        nullif(properties->>'LVL1_ZONE','')
      )
    )
  `;

  const params = [lng, lat];
  const predicates = [];
  if (codeNorm) {
    params.push(codeNorm);
    predicates.push(`${codeExpr} = $${params.length}`);
  }
  if (nameNorm) {
    params.push(`%${nameNorm}%`);
    predicates.push(`${nameExpr} LIKE $${params.length}`);
  }
  if (nameCoreNorm && nameCoreNorm !== nameNorm) {
    params.push(`%${nameCoreNorm}%`);
    predicates.push(`${nameExpr} LIKE $${params.length}`);
  }

  if (!predicates.length) return null;

  params.push(withinDistanceMeters);
  const distIdx = params.length;

  const sql = `
    WITH src AS (
      SELECT ST_MakeValid(${geom4326}) AS g
      FROM ${table}
      WHERE (${predicates.join(" OR ")})
        AND ST_DWithin((${geom4326})::geography, (${pointExpr})::geography, $${distIdx})
    ),
    merged AS (
      SELECT
        COUNT(*)::int AS feature_count,
        ST_UnaryUnion(ST_Collect(g)) AS g
      FROM src
    )
    SELECT
      feature_count,
      ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(
          ST_MakeValid(g),
          0.00001
        )
      ) AS geom_geojson
    FROM merged;
  `;

  try {
    const { rows } = await pool.query(sql, params);
    const row = rows?.[0];
    const geometry = safeJsonParse(row?.geom_geojson);
    const featureCount = Number(row?.feature_count || 0);
    if (!geometry || featureCount < 1) return null;
    return { geometry, featureCount };
  } catch (err) {
    console.error(
      `[townplanner_v2] queryZoningContextGeometry failed for ${table}:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * Merge nearby geometries from a table into a single context geometry.
 * Useful for overlays that are split into adjacent polygons by roads.
 */
async function queryGeometryContextByDistance({
  table,
  lng,
  lat,
  withinDistanceMeters = 260,
  clipDistanceMeters = null,
}) {
  if (!pool) return null;
  if (!table) return null;
  if (!(await tableExists(table))) return null;

  const geom4326 = geomTo4326Sql("geom");
  const pointExpr = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";
  const clipMeters = Number(clipDistanceMeters);
  const safeClipMeters =
    Number.isFinite(clipMeters) && clipMeters > 0 ? clipMeters : 0;

  const sql = `
    WITH pt AS (
      SELECT ${pointExpr} AS p
    ),
    src AS (
      SELECT ST_MakeValid(${geom4326}) AS g
      FROM ${table}, pt
      WHERE ST_DWithin((${geom4326})::geography, pt.p::geography, $3)
    ),
    clipped AS (
      SELECT
        CASE
          WHEN $4 > 0
            THEN ST_MakeValid(
              ST_Intersection(
                g,
                ST_Buffer(pt.p::geography, $4)::geometry
              )
            )
          ELSE g
        END AS g
      FROM src, pt
    ),
    merged AS (
      SELECT
        COUNT(*)::int AS feature_count,
        ST_UnaryUnion(ST_Collect(g)) AS g
      FROM clipped
      WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)
    )
    SELECT
      feature_count,
      ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(
          ST_MakeValid(g),
          0.00001
        )
      ) AS geom_geojson
    FROM merged;
  `;

  try {
    const { rows } = await pool.query(sql, [
      lng,
      lat,
      withinDistanceMeters,
      safeClipMeters,
    ]);
    const row = rows?.[0];
    const featureCount = Number(row?.feature_count || 0);
    const geometry = safeJsonParse(row?.geom_geojson);
    if (!geometry || featureCount < 1) return null;
    return { geometry, featureCount };
  } catch (err) {
    console.error(
      `[townplanner_v2] queryGeometryContextByDistance failed for ${table}:`,
      err?.message || err
    );
    return null;
  }
}

/**
 * For line/network layers: prefer parcel proximity if parcel geom exists,
 * otherwise fallback to point-based queryOne.
 */
async function queryNearParcel(
  table,
  lng,
  lat,
  parcelGeomGeoJSON,
  withinDistanceMeters
) {
  if (!pool) return null;

  // Skip missing tables cleanly
  if (!(await tableExists(table))) return null;

  if (!parcelGeomGeoJSON || typeof withinDistanceMeters !== "number") {
    return queryOne(table, lng, lat, withinDistanceMeters);
  }

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
    WHERE ST_DWithin((${geom4326})::geography, parcel.g::geography, $2)
    ORDER BY ST_Distance((${geom4326})::geography, parcel.g::geography)
    LIMIT 1;
  `;

  try {
    const { rows } = await pool.query(sql, [
      JSON.stringify(parcelGeomGeoJSON),
      withinDistanceMeters,
    ]);
    if (!rows?.length) return null;
    const row = rows[0];
    return {
      properties: row.properties || {},
      geometry: safeJsonParse(row.geom_geojson),
    };
  } catch (err) {
    console.error(
      `[townplanner_v2] queryNearParcel failed for ${table}:`,
      err?.message || err
    );
    return null;
  }
}

async function queryStateMappingLayer({
  table,
  lng,
  lat,
  parcelGeomGeoJSON,
  contextDistanceMeters = 1200,
  clipDistanceMeters = null,
}) {
  if (!table) return null;

  let hit = null;
  if (parcelGeomGeoJSON) {
    hit = await queryIntersects(table, parcelGeomGeoJSON);
  }
  if (!hit) {
    hit = await queryOne(table, lng, lat);
  }
  if (!hit?.properties) return null;

  let renderGeometry = hit.geometry || null;
  const contextDistance = Number(contextDistanceMeters);
  if (Number.isFinite(contextDistance) && contextDistance > 0) {
    const context = await queryGeometryContextByDistance({
      table,
      lng,
      lat,
      withinDistanceMeters: contextDistance,
      clipDistanceMeters:
        Number.isFinite(Number(clipDistanceMeters)) &&
        Number(clipDistanceMeters) > 0
          ? Number(clipDistanceMeters)
          : contextDistance,
    });
    if (context?.geometry) renderGeometry = context.geometry;
  }

  return {
    properties: hit.properties || {},
    geometry: renderGeometry,
  };
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
  // DAMS transport layers are rendered as nearby contextual constraints.
  // Keep configurable via env for tuning without code changes.
  const DAMS_LAYER_DISTANCE_M = Number(
    process.env.TOWNPLANNER_DAMS_LAYER_DISTANCE_M || 2000
  );
  // For report maps, use merged nearby DAMS geometry so corridor context
  // matches the official DAMS map view rather than a single nearest feature.
  const DAMS_CONTEXT_DISTANCE_M = Number(
    process.env.TOWNPLANNER_DAMS_CONTEXT_DISTANCE_M || 2200
  );
  const parcelGeom = parcel?.geometry || null;

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

  const stateTransportPromises = DAMS_STATE_TRANSPORT_LAYERS.map((layer) =>
    queryNearParcel(
      layer.table,
      focusLng,
      focusLat,
      parcelGeom,
      DAMS_LAYER_DISTANCE_M
    )
  );

  const acidSulfatePromises = ACID_SULFATE_OVERLAY_LAYERS.map((layer) =>
    parcelGeom
      ? queryIntersects(layer.table, parcelGeom)
      : queryOne(layer.table, focusLng, focusLat)
  );

  const stateMappingPromises = STATE_MAPPING_CONSIDERATION_LAYERS.map((layer) =>
    queryStateMappingLayer({
      table: layer.table,
      lng: focusLng,
      lat: focusLat,
      parcelGeomGeoJSON: parcelGeom,
      contextDistanceMeters: layer.contextDistanceMeters,
      clipDistanceMeters: layer.clipDistanceMeters,
    })
  );

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
    ...acidSulfateHitsAndStateTransportAndStateMappingHits
  ] = await Promise.all([
    queryOne("bcc_zoning", focusLng, focusLat, {
      preferLargestArea: true,
    }),
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
    queryNearParcel(
      "bcc_bicycle_network_overlay",
      focusLng,
      focusLat,
      parcelGeom,
      LINE_OVERLAY_DISTANCE_M
    ),
    queryOne(
      "bcc_critical_infrastructure_movement_assets",
      focusLng,
      focusLat
    ),
    queryNearParcel(
      "bcc_road_hierarchy",
      focusLng,
      focusLat,
      parcelGeom,
      LINE_OVERLAY_DISTANCE_M
    ),
    queryNearParcel(
      "bcc_streetscape_hierarchy",
      focusLng,
      focusLat,
      parcelGeom,
      LINE_OVERLAY_DISTANCE_M
    ),
    ...acidSulfatePromises,
    ...stateTransportPromises,
    ...stateMappingPromises,
  ]);

  const acidSulfateHits = acidSulfateHitsAndStateTransportAndStateMappingHits.slice(
    0,
    ACID_SULFATE_OVERLAY_LAYERS.length
  );
  const stateTransportHits = acidSulfateHitsAndStateTransportAndStateMappingHits.slice(
    ACID_SULFATE_OVERLAY_LAYERS.length,
    ACID_SULFATE_OVERLAY_LAYERS.length + DAMS_STATE_TRANSPORT_LAYERS.length
  );
  const stateMappingHits = acidSulfateHitsAndStateTransportAndStateMappingHits.slice(
    ACID_SULFATE_OVERLAY_LAYERS.length + DAMS_STATE_TRANSPORT_LAYERS.length
  );

  if (bicycleNetwork?.properties) {
    const bp = bicycleNetwork.properties || {};
    console.info("[townplanner_v2] bicycle overlay hit", {
      lat: safeLat,
      lng: safeLng,
      focusLat,
      focusLng,
      usedParcel: !!parcelGeom,
      ovl2_desc: bp.ovl2_desc || bp.OVL2_DESC || null,
      description: bp.description || bp.DESCRIPTION || null,
      route: bp.route || bp.ROUTE || null,
      route_type: bp.route_type || bp.ROUTE_TYPE || null,
      network: bp.network || bp.NETWORK || null,
    });
  } else {
    console.info("[townplanner_v2] bicycle overlay not found", {
      lat: safeLat,
      lng: safeLng,
      focusLat,
      focusLng,
      usedParcel: !!parcelGeom,
    });
  }

  const dwellingContext = dwellingCharacter?.geometry
    ? await queryGeometryContextByDistance({
        table: "bcc_dwelling_house_character",
        lng: focusLng,
        lat: focusLat,
        withinDistanceMeters: 260,
      })
    : null;
  const dwellingCharacterGeom =
    dwellingContext?.geometry || dwellingCharacter?.geometry || null;
  console.info("[townplanner_v2] dwelling overlay context", {
    lat: safeLat,
    lng: safeLng,
    focusLat,
    focusLng,
    baseType: dwellingCharacter?.geometry?.type || null,
    contextType: dwellingContext?.geometry?.type || null,
    contextFeatureCount: dwellingContext?.featureCount || 0,
  });

  const streetscapeContext = streetscapeHierarchy?.geometry
    ? await queryGeometryContextByDistance({
        table: "bcc_streetscape_hierarchy",
        lng: focusLng,
        lat: focusLat,
        withinDistanceMeters: 220,
      })
    : null;
  const streetscapeHierarchyGeom =
    streetscapeContext?.geometry || streetscapeHierarchy?.geometry || null;
  console.info("[townplanner_v2] streetscape overlay context", {
    lat: safeLat,
    lng: safeLng,
    focusLat,
    focusLng,
    baseType: streetscapeHierarchy?.geometry?.type || null,
    contextType: streetscapeContext?.geometry?.type || null,
    contextFeatureCount: streetscapeContext?.featureCount || 0,
  });

  const zoningProps = zoning?.properties || null;

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

  const zoningContext = await queryZoningContextGeometry({
    table: "bcc_zoning",
    lng: focusLng,
    lat: focusLat,
    zoneCode: zoningCode,
    zoneName: zoningName,
    withinDistanceMeters: 320,
  });
  const zoningPolygon = zoningContext?.geometry || zoning?.geometry || null;
  console.info("[townplanner_v2] zoning context geometry", {
    lat: safeLat,
    lng: safeLng,
    focusLat,
    focusLng,
    zoningCode,
    zoningName,
    baseType: zoning?.geometry?.type || null,
    contextType: zoningContext?.geometry?.type || null,
    contextFeatureCount: zoningContext?.featureCount || 0,
  });

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
  pushOverlay(dwellingCharacter?.properties, dwellingCharacterGeom, {
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

  const acidSulfateLayerHit = ACID_SULFATE_OVERLAY_LAYERS.map((layer, idx) => ({
    ...layer,
    hit: acidSulfateHits?.[idx] || null,
  })).find((item) => item?.hit?.properties);
  const acidSulfateDetail = overlayDetail(
    acidSulfateLayerHit?.hit?.properties,
    overlayDetailKeys,
    acidSulfateLayerHit?.detail || null
  );
  pushOverlay(
    acidSulfateLayerHit?.hit?.properties,
    acidSulfateLayerHit?.hit?.geometry,
    {
      name: overlayName(
        "Potential and actual acid sulfate soils overlay",
        acidSulfateDetail
      ),
      code: "overlay_potential_actual_acid_sulfate_soils",
      severity: acidSulfateDetail || "mapped overlay",
    }
  );

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
  pushOverlay(streetscapeHierarchy?.properties, streetscapeHierarchyGeom, {
    name: overlayName("Streetscape hierarchy overlay", streetscapeDetail),
    code: "overlay_streetscape_hierarchy",
    severity: streetscapeDetail || "mapped overlay",
  });

  const rawDamsStateTransport = {};
  for (let i = 0; i < DAMS_STATE_TRANSPORT_LAYERS.length; i += 1) {
    const layer = DAMS_STATE_TRANSPORT_LAYERS[i];
    const hit = stateTransportHits?.[i] || null;
    if (!hit?.properties) continue;
    const is25mLayer = String(layer?.code || "").includes("_25m_");

    let renderGeometry = hit.geometry || null;
    const context = await queryGeometryContextByDistance({
      table: layer.table,
      lng: focusLng,
      lat: focusLat,
      withinDistanceMeters: DAMS_CONTEXT_DISTANCE_M,
      clipDistanceMeters: is25mLayer ? DAMS_CONTEXT_DISTANCE_M : null,
    });
    if (context?.geometry) {
      renderGeometry = context.geometry;
    }

    rawDamsStateTransport[layer.code] = hit.properties;
    pushOverlay(hit.properties, renderGeometry, {
      name: overlayName("State transport corridor", layer.detail),
      code: layer.code,
      severity: layer.detail,
    });
  }

  const stateMappingConsiderations = [];
  const stateMappingPolygons = [];
  const rawStateMappingConsiderations = {};

  for (let i = 0; i < STATE_MAPPING_CONSIDERATION_LAYERS.length; i += 1) {
    const layer = STATE_MAPPING_CONSIDERATION_LAYERS[i];
    let hit = stateMappingHits?.[i] || null;
    if (
      !hit?.properties &&
      String(layer?.code || "") === VEGETATION_LAYER_CODE
    ) {
      const fallbackProps = await queryVegetationCategoryArcgis({
        lng: focusLng,
        lat: focusLat,
      });
      if (fallbackProps) {
        hit = {
          properties: fallbackProps,
          geometry: null,
        };
      }
    }
    if (!hit?.properties) continue;

    const detail = buildStateMappingDetail(layer, hit.properties || {});
    stateMappingConsiderations.push({
      code: layer.code,
      sectionTitle: layer.sectionTitle,
      subsectionTitle: layer.subsectionTitle,
      name: layer.name,
      detail,
      source: layer.source,
    });

    if (hit.geometry) {
      stateMappingPolygons.push({
        code: layer.code,
        geometry: hit.geometry,
      });
    }

    rawStateMappingConsiderations[layer.code] = hit.properties;
  }

  // Services meta for reporting (not necessarily a map overlay page)
  const rawLgipNetworkKey = lgipNetworkKey?.properties || null;

  return {
    planningDataVersion: PLANNING_SNAPSHOT_VERSION,
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
    stateMappingConsiderations,
    stateMappingPolygons,

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
    rawPotentialActualAcidSulfateSoils:
      acidSulfateLayerHit?.hit?.properties || null,
    rawLgipNetworkKey,
    rawBicycleNetwork: bicycleNetwork?.properties || null,
    rawCriticalInfrastructureMovementAssets:
      criticalInfrastructureMovementAssets?.properties || null,
    rawRoadHierarchy: roadHierarchy?.properties || null,
    rawStreetscapeHierarchy: streetscapeHierarchy?.properties || null,
    rawDamsStateTransport:
      Object.keys(rawDamsStateTransport).length > 0
        ? rawDamsStateTransport
        : null,
    rawStateMappingConsiderations:
      Object.keys(rawStateMappingConsiderations).length > 0
        ? rawStateMappingConsiderations
        : null,
  };
}
