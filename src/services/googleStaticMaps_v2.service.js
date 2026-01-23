// src/services/googleStaticMaps_v2.service.js
//
// Google Static Maps helpers (server-side)
// - Renders parcel outline (and optional overlay highlight) as paths.
// - Uses "visible" bounds to fit content.
//
// Requirements:
// - process.env.GOOGLE_MAPS_API_KEY
// - Static Maps API enabled + billing in Google Cloud

import axios from "axios";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!GOOGLE_MAPS_API_KEY) {
  throw new Error("Missing GOOGLE_MAPS_API_KEY env var");
}

const STATIC_MAPS_BASE = "https://maps.googleapis.com/maps/api/staticmap";

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function getRingsFromGeoJSON(geo) {
  if (!geo) return [];
  const { type, coordinates } = geo;

  if (type === "Polygon" && Array.isArray(coordinates) && coordinates[0]) {
    return [coordinates[0]];
  }
  if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    let best = null;
    let bestLen = 0;
    for (const poly of coordinates) {
      const ring = poly?.[0];
      if (Array.isArray(ring) && ring.length > bestLen) {
        best = ring;
        bestLen = ring.length;
      }
    }
    return best ? [best] : [];
  }
  if (type === "LineString" && Array.isArray(coordinates)) {
    return [coordinates];
  }
  if (
    type === "MultiLineString" &&
    Array.isArray(coordinates) &&
    coordinates[0]
  ) {
    return [coordinates[0]];
  }
  return [];
}

function bboxFromCoords(coords) {
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;

  for (const c of coords) {
    const lng = c?.[0];
    const lat = c?.[1];
    if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) continue;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }

  if (!Number.isFinite(minLng)) return null;
  return { minLng, minLat, maxLng, maxLat };
}

function mergeBboxes(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minLng: Math.min(a.minLng, b.minLng),
    minLat: Math.min(a.minLat, b.minLat),
    maxLng: Math.max(a.maxLng, b.maxLng),
    maxLat: Math.max(a.maxLat, b.maxLat),
  };
}

function bboxToVisiblePoints(bbox, padFactor = 0.12) {
  const lngPad = (bbox.maxLng - bbox.minLng) * padFactor;
  const latPad = (bbox.maxLat - bbox.minLat) * padFactor;

  const minLng = bbox.minLng - lngPad;
  const maxLng = bbox.maxLng + lngPad;
  const minLat = bbox.minLat - latPad;
  const maxLat = bbox.maxLat + latPad;

  return [
    [minLat, minLng],
    [minLat, maxLng],
    [maxLat, minLng],
    [maxLat, maxLng],
  ];
}

// Google encoded polyline
function encodeSignedNumber(num) {
  let sgnNum = num << 1;
  if (num < 0) sgnNum = ~sgnNum;
  return encodeNumber(sgnNum);
}

function encodeNumber(num) {
  let encoded = "";
  while (num >= 0x20) {
    encoded += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
    num >>= 5;
  }
  encoded += String.fromCharCode(num + 63);
  return encoded;
}

function encodePolyline(points) {
  let prevLat = 0;
  let prevLng = 0;
  let result = "";

  for (const p of points) {
    const lat = Math.round(p[0] * 1e5);
    const lng = Math.round(p[1] * 1e5);

    const dLat = lat - prevLat;
    const dLng = lng - prevLng;

    prevLat = lat;
    prevLng = lng;

    result += encodeSignedNumber(dLat) + encodeSignedNumber(dLng);
  }
  return result;
}

function downsampleRingLngLat(ringLngLat, maxPoints = 320) {
  if (!Array.isArray(ringLngLat) || ringLngLat.length <= maxPoints)
    return ringLngLat;
  const step = Math.ceil(ringLngLat.length / maxPoints);
  const out = [];
  for (let i = 0; i < ringLngLat.length; i += step) out.push(ringLngLat[i]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1]))
    out.push(first);
  return out;
}

function toLatLngPairs(ringLngLat) {
  return ringLngLat
    .map((c) => [c[1], c[0]])
    .filter((p) => isFiniteNumber(p[0]) && isFiniteNumber(p[1]));
}

function buildStaticMapUrl({ size, scale, maptype, visiblePoints, paths }) {
  const params = new URLSearchParams();

  params.set("size", size);
  params.set("scale", String(scale));
  params.set("maptype", maptype);
  params.set("format", "png");
  params.set("key", GOOGLE_MAPS_API_KEY);

  if (visiblePoints?.length) {
    params.set(
      "visible",
      visiblePoints.map((p) => `${p[0]},${p[1]}`).join("|")
    );
  }

  for (const p of paths || []) params.append("path", p);

  return `${STATIC_MAPS_BASE}?${params.toString()}`;
}

async function fetchPng(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return Buffer.from(resp.data);
}

export async function getParcelMapImageBufferV2({
  parcelGeoJSON,
  size = "640x360",
  maptype = "hybrid",
  scale = 2,
}) {
  const ring = getRingsFromGeoJSON(parcelGeoJSON)?.[0];
  if (!ring?.length) return null;

  const ringDs = downsampleRingLngLat(ring);
  const latLng = toLatLngPairs(ringDs);
  const enc = encodePolyline(latLng);

  const bbox = bboxFromCoords(ring);
  const visiblePoints = bbox ? bboxToVisiblePoints(bbox) : [];

  const parcelPath = `fillcolor:0x00A65122|color:0x00A651FF|weight:4|enc:${enc}`;

  const url = buildStaticMapUrl({
    size,
    scale,
    maptype,
    visiblePoints,
    paths: [parcelPath],
  });

  return fetchPng(url);
}

export async function getParcelOverlayMapImageBufferV2({
  parcelGeoJSON,
  overlayGeoJSON,
  size = "640x360",
  maptype = "hybrid",
  scale = 2,
}) {
  const parcelRing = getRingsFromGeoJSON(parcelGeoJSON)?.[0] || null;
  if (!parcelRing?.length) return null;

  const parcelRingDs = downsampleRingLngLat(parcelRing);
  const parcelLatLng = toLatLngPairs(parcelRingDs);
  const parcelEnc = encodePolyline(parcelLatLng);

  const overlayRing = getRingsFromGeoJSON(overlayGeoJSON)?.[0] || null;
  let overlayEnc = null;

  if (overlayRing?.length) {
    const overlayRingDs = downsampleRingLngLat(overlayRing);
    const overlayLatLng = toLatLngPairs(overlayRingDs);
    overlayEnc = encodePolyline(overlayLatLng);
  }

  const bboxParcel = bboxFromCoords(parcelRing);
  const bboxOverlay = overlayRing ? bboxFromCoords(overlayRing) : null;
  const bbox = mergeBboxes(bboxParcel, bboxOverlay);
  const visiblePoints = bbox ? bboxToVisiblePoints(bbox) : [];

  const paths = [];

  if (overlayEnc) {
    paths.push(
      `fillcolor:0xFF000022|color:0xFF0000FF|weight:3|enc:${overlayEnc}`
    );
  }

  // Parcel outline on top
  paths.push(`fillcolor:0x00A65112|color:0x00A651FF|weight:4|enc:${parcelEnc}`);

  const url = buildStaticMapUrl({
    size,
    scale,
    maptype,
    visiblePoints,
    paths,
  });

  return fetchPng(url);
}
