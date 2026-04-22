import "dotenv/config";
import pg from "pg";
import * as turf from "@turf/turf";

async function getParcelGeometry() {
  const { Client } = pg;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("neon.tech")
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();
  try {
    const sql = `
      select ST_AsGeoJSON(
        case
          when st_srid(geom) = 4326 then geom
          when st_srid(geom) = 0 then st_setsrid(geom, 4326)
          else st_transform(geom, 4326)
        end
      ) as geom
      from bcc_property_parcels
      where properties->>'lot' = '8'
        and properties->>'plan' = 'RP891407'
      limit 1
    `;
    const result = await client.query(sql);
    return result.rows[0]?.geom ? JSON.parse(result.rows[0].geom) : null;
  } finally {
    await client.end();
  }
}

function intersects(parcelGeometry, sourceGeometry) {
  if (!parcelGeometry || !sourceGeometry) return false;
  return turf.booleanIntersects(
    turf.feature(parcelGeometry),
    turf.feature(sourceGeometry),
  );
}

async function checkBccScreening(parcelGeometry) {
  const resp = await fetch(
    "https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/acid-sulfate-soils-areas/records?limit=100",
  );
  const data = await resp.json();
  const hits = [];
  for (const row of data.results || []) {
    const geometry = row?.geo_shape?.geometry || null;
    if (!geometry) continue;
    if (intersects(parcelGeometry, geometry)) {
      hits.push({
        objectid: row.objectid ?? null,
        acid_sulph: row.acid_sulph ?? null,
      });
    }
  }
  return {
    dataset: "bcc_acid_sulfate_soils_areas",
    total_count: data.total_count ?? null,
    hits,
  };
}

async function queryQldLayer(layerId, parcelGeometry) {
  const rings =
    parcelGeometry?.type === "Polygon"
      ? parcelGeometry.coordinates
      : parcelGeometry?.type === "MultiPolygon"
        ? parcelGeometry.coordinates?.[0] || null
        : null;
  if (!rings) {
    return {
      layerId,
      url: null,
      featureCount: 0,
      sampleAttributes: null,
      error: `Unsupported parcel geometry type: ${parcelGeometry?.type || "unknown"}`,
    };
  }
  const params = new URLSearchParams({
    geometry: JSON.stringify({
      rings,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryPolygon",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "*",
    f: "pjson",
  });
  const url = `https://spatial-gis.information.qld.gov.au/arcgis/rest/services/GeoscientificInformation/SoilsAndLandResource/MapServer/${layerId}/query?${params.toString()}`;
  const resp = await fetch(url);
  const data = await resp.json();
  return {
    layerId,
    url,
    featureCount: Array.isArray(data?.features) ? data.features.length : 0,
    sampleAttributes: data?.features?.[0]?.attributes || null,
  };
}

const parcelGeometry = await getParcelGeometry();
if (!parcelGeometry) {
  console.error("Parcel not found for Lot 8 RP891407");
  process.exit(1);
}

const result = {
  bccScreening: await checkBccScreening(parcelGeometry),
  qldAcidSulfateLayers: [
    await queryQldLayer(1902, parcelGeometry),
    await queryQldLayer(1952, parcelGeometry),
    await queryQldLayer(2002, parcelGeometry),
    await queryQldLayer(2052, parcelGeometry),
  ],
};

console.log(JSON.stringify(result, null, 2));
