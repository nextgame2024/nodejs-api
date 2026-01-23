// googleStaticMaps_v2.service.js
import axios from "axios";

/**
 * Utility: Extract a polygon ring (array of [lng,lat]) from a GeoJSON Feature/Geometry.
 * Supports Polygon and MultiPolygon (takes the largest outer ring).
 */
function extractPolygonRing(geojson) {
  if (!geojson) return null;

  const geom =
    geojson?.type === "Feature"
      ? geojson.geometry
      : geojson?.geometry || geojson;

  if (!geom) return null;

  if (geom.type === "Polygon") {
    const ring = geom.coordinates?.[0];
    return Array.isArray(ring) && ring.length ? ring : null;
  }

  if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates || [];
    if (!polys.length) return null;

    // choose the polygon with the biggest ring length as a proxy for "largest"
    let best = null;
    let bestLen = 0;
    for (const poly of polys) {
      const ring = poly?.[0];
      const len = Array.isArray(ring) ? ring.length : 0;
      if (len > bestLen) {
        bestLen = len;
        best = ring;
      }
    }
    return bestLen ? best : null;
  }

  return null;
}

/**
 * Encode a polygon ring to a Google Static Maps polyline path.
 * Uses Encoded Polyline Algorithm Format.
 *
 * NOTE: Google expects lat,lng in encoding sequence (not lng,lat).
 */
function encodeSigned(num) {
  let sgnNum = num << 1;
  if (num < 0) sgnNum = ~sgnNum;
  let encoded = "";
  while (sgnNum >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  encoded += String.fromCharCode(sgnNum + 63);
  return encoded;
}

function encodePolyline(pointsLatLng) {
  let lastLat = 0;
  let lastLng = 0;
  let result = "";

  for (const [lat, lng] of pointsLatLng) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);

    const dLat = latE5 - lastLat;
    const dLng = lngE5 - lastLng;

    lastLat = latE5;
    lastLng = lngE5;

    result += encodeSigned(dLat);
    result += encodeSigned(dLng);
  }

  return result;
}

function ringToEncodedPath(ringLngLat) {
  // Convert [lng,lat] -> [lat,lng]
  const pts = ringLngLat.map(([lng, lat]) => [lat, lng]);

  // Ensure closed ring
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    pts.push([first[0], first[1]]);
  }

  return `enc:${encodePolyline(pts)}`;
}

function centroidFromRing(ringLngLat) {
  let sumLng = 0;
  let sumLat = 0;
  let n = 0;

  for (const [lng, lat] of ringLngLat) {
    sumLng += lng;
    sumLat += lat;
    n += 1;
  }

  if (!n) return null;
  return { lng: sumLng / n, lat: sumLat / n };
}

function isImagePng(resp) {
  const ct = resp?.headers?.["content-type"] || resp?.headers?.["Content-Type"];
  return typeof ct === "string" && ct.toLowerCase().includes("image/png");
}

async function fetchStaticMapPngBuffer(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    validateStatus: () => true,
  });

  if (resp.status !== 200 || !isImagePng(resp) || !resp.data) return null;
  return Buffer.from(resp.data);
}

function appendStylesAndMapId(url, styles, mapId) {
  let out = url;
  if (mapId) {
    out += `&map_id=${encodeURIComponent(String(mapId))}`;
  }
  if (Array.isArray(styles)) {
    for (const s of styles) {
      const str = String(s || "").trim();
      if (str) out += `&style=${encodeURIComponent(str)}`;
    }
  }
  return out;
}

/**
 * Parcel-only map
 */
export async function getParcelMapImageBufferV2({
  apiKey,
  center, // {lat,lng} optional
  zoom = 19,
  size = "640x360",
  scale = 2,
  maptype = "hybrid",
  parcelGeoJson, // Feature with Polygon/MultiPolygon

  // NEW (optional):
  styles = null, // array of Google Static Map "style" strings
  mapId = null, // Google Cloud Map ID (if you use cloud styling)
}) {
  if (!apiKey) return null;

  const ring = extractPolygonRing(parcelGeoJson);
  if (!ring) return null;

  const c = center || centroidFromRing(ring);
  if (!c) return null;

  const parcelPath = ringToEncodedPath(ring);

  const path = [
    `fillcolor:0x2ecc7130`,
    `color:0x2ecc71ff`,
    `weight:4`,
    parcelPath,
  ].join("|");

  let url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?format=png` +
    `&size=${encodeURIComponent(size)}` +
    `&scale=${encodeURIComponent(scale)}` +
    `&maptype=${encodeURIComponent(maptype)}` +
    `&center=${encodeURIComponent(`${c.lat},${c.lng}`)}` +
    `&zoom=${encodeURIComponent(zoom)}` +
    `&path=${encodeURIComponent(path)}` +
    `&key=${encodeURIComponent(apiKey)}`;

  url = appendStylesAndMapId(url, styles, mapId);
  return fetchStaticMapPngBuffer(url);
}

/**
 * Parcel + overlay map
 */
export async function getParcelOverlayMapImageBufferV2({
  apiKey,
  center, // {lat,lng} optional
  zoom = 17,
  size = "640x360",
  scale = 2,
  maptype = "hybrid",
  parcelGeoJson,
  overlayGeoJson,

  overlayColor = "0xff7f00ff",
  overlayFill = "0xff7f0030",

  // NEW (optional):
  styles = null,
  mapId = null,
}) {
  if (!apiKey) return null;

  const parcelRing = extractPolygonRing(parcelGeoJson);
  if (!parcelRing) return null;

  const overlayRing = extractPolygonRing(overlayGeoJson);
  if (!overlayRing) return null;

  const c =
    center || centroidFromRing(parcelRing) || centroidFromRing(overlayRing);
  if (!c) return null;

  const parcelPathEnc = ringToEncodedPath(parcelRing);
  const overlayPathEnc = ringToEncodedPath(overlayRing);

  const parcelPath = [
    `fillcolor:0x2ecc7130`,
    `color:0x2ecc71ff`,
    `weight:4`,
    parcelPathEnc,
  ].join("|");

  const overlayPath = [
    `fillcolor:${overlayFill}`,
    `color:${overlayColor}`,
    `weight:4`,
    overlayPathEnc,
  ].join("|");

  let url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?format=png` +
    `&size=${encodeURIComponent(size)}` +
    `&scale=${encodeURIComponent(scale)}` +
    `&maptype=${encodeURIComponent(maptype)}` +
    `&center=${encodeURIComponent(`${c.lat},${c.lng}`)}` +
    `&zoom=${encodeURIComponent(zoom)}` +
    `&path=${encodeURIComponent(parcelPath)}` +
    `&path=${encodeURIComponent(overlayPath)}` +
    `&key=${encodeURIComponent(apiKey)}`;

  url = appendStylesAndMapId(url, styles, mapId);
  return fetchStaticMapPngBuffer(url);
}

/**
 * Backwards-compatible aliases
 */
export const staticMapParcelOnly = getParcelMapImageBufferV2;
export const staticMapParcelOverlay = getParcelOverlayMapImageBufferV2;
