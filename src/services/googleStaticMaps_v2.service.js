// googleStaticMaps_v2.service.js
import axios from "axios";

const MAX_URL_LEN = 7600; // conservative under typical 8KB proxy limits
const MAX_RING_POINTS = 240; // keep paths small and reliable
const DEFAULT_TIMEOUT_MS = 20000;

const WEB_MERCATOR_MAX_LAT = 85.05112878;

function clampLat(lat) {
  return Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, lat));
}

function parseSize(sizeStr) {
  const m = String(sizeStr || "").match(/^(\d+)x(\d+)$/);
  if (!m) return { w: 640, h: 360 };
  return { w: Number(m[1]) || 640, h: Number(m[2]) || 360 };
}

/**
 * Convert lat/lng to "world coordinates" in Web Mercator at zoom 0.
 * x,y in [0..1] range.
 */
function latLngToWorld(lat, lng) {
  const clampedLat = clampLat(lat);
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const x = (lng + 180) / 360;
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

function boundsFromRings(ringsLngLat) {
  let minLat = 90,
    maxLat = -90,
    minLng = 180,
    maxLng = -180;

  let has = false;

  for (const ring of ringsLngLat) {
    if (!Array.isArray(ring)) continue;
    for (const p of ring) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const lng = Number(p[0]);
      const lat = Number(p[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      has = true;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }

  if (!has) return null;

  // Clamp lat range to avoid Mercator blow-ups
  minLat = clampLat(minLat);
  maxLat = clampLat(maxLat);

  return { minLat, maxLat, minLng, maxLng };
}

function centerFromBounds(b) {
  if (!b) return null;
  return {
    lat: (b.minLat + b.maxLat) / 2,
    lng: (b.minLng + b.maxLng) / 2,
  };
}

/**
 * Compute a zoom level that fits the bounds into the image size (px),
 * with padding (px) on all sides.
 *
 * Google tiles are 256px at zoom 0.
 */
function fitZoomForBounds({
  bounds,
  size,
  scale,
  paddingPx = 80,
  maxZoom = 20,
}) {
  if (!bounds) return Math.min(maxZoom, 17);

  const { w, h } = parseSize(size);
  const mapW = Math.max(64, w * (Number(scale) || 1) - 2 * paddingPx);
  const mapH = Math.max(64, h * (Number(scale) || 1) - 2 * paddingPx);

  // Handle nearly-point bounds
  const sw = latLngToWorld(bounds.minLat, bounds.minLng);
  const ne = latLngToWorld(bounds.maxLat, bounds.maxLng);

  const dx = Math.max(1e-9, Math.abs(ne.x - sw.x));
  const dy = Math.max(1e-9, Math.abs(ne.y - sw.y));

  // pixels = worldDelta * 256 * 2^z
  const zoomX = Math.log2(mapW / (256 * dx));
  const zoomY = Math.log2(mapH / (256 * dy));
  const z = Math.floor(Math.min(zoomX, zoomY));

  // Keep sane bounds
  return Math.max(3, Math.min(maxZoom, z));
}

/**
 * Extract outer ring (array of [lng,lat]) from GeoJSON Feature/Geometry.
 * Supports Polygon and MultiPolygon (chooses the largest outer ring).
 */
function extractPolygonRing(geojson) {
  const rings = extractPolygonRings(geojson);
  if (!rings.length) return null;
  let best = rings[0];
  let bestLen = Array.isArray(best) ? best.length : 0;
  for (const ring of rings) {
    const len = Array.isArray(ring) ? ring.length : 0;
    if (len > bestLen) {
      best = ring;
      bestLen = len;
    }
  }
  return best;
}

/**
 * Extract outer rings (array of [lng,lat] arrays) from GeoJSON Feature/Geometry.
 * Supports Polygon and MultiPolygon.
 */
function extractPolygonRings(geojson) {
  if (!geojson) return [];

  const geom =
    geojson?.type === "Feature"
      ? geojson.geometry
      : geojson?.geometry || geojson;

  if (!geom) return null;

  if (geom.type === "Polygon") {
    const ring = geom.coordinates?.[0];
    return Array.isArray(ring) && ring.length ? [ring] : [];
  }

  if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates || [];
    if (!polys.length) return [];
    return polys
      .map((poly) => poly?.[0])
      .filter((ring) => Array.isArray(ring) && ring.length);
  }

  return [];
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

/** Remove consecutive duplicates, invalid points, and close ring. */
function normalizeRing(ringLngLat) {
  if (!Array.isArray(ringLngLat) || ringLngLat.length < 4) return null;

  const cleaned = [];
  let prev = null;

  for (const p of ringLngLat) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lng = round6(p[0]);
    const lat = round6(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    const cur = [lng, lat];
    if (!prev || prev[0] !== cur[0] || prev[1] !== cur[1]) {
      cleaned.push(cur);
      prev = cur;
    }
  }

  if (cleaned.length < 4) return null;

  // close ring
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1])
    cleaned.push([first[0], first[1]]);

  return cleaned.length >= 4 ? cleaned : null;
}

/**
 * Ramer–Douglas–Peucker simplification (degrees).
 * Works fine for our goal: reduce URL/path size reliably.
 */
function perpendicularDistance(p, a, b) {
  const [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;

  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    const ddx = x - x1;
    const ddy = y - y1;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }

  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  const ddx = x - projX;
  const ddy = y - projY;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

function rdp(points, epsilon) {
  if (!Array.isArray(points) || points.length < 3) return points;

  let dmax = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }

  if (dmax > epsilon) {
    const rec1 = rdp(points.slice(0, index + 1), epsilon);
    const rec2 = rdp(points.slice(index, end + 1), epsilon);
    return rec1.slice(0, rec1.length - 1).concat(rec2);
  }

  return [points[0], points[end]];
}

function simplifyRing(ringLngLat, epsilonDeg, maxPoints) {
  const ring = normalizeRing(ringLngLat);
  if (!ring) return null;

  // Remove closing point for simplification, then re-close
  const open = ring.slice(0, -1);

  let simplified = rdp(open, epsilonDeg);

  // If still too many points, downsample deterministically
  if (simplified.length > maxPoints) {
    const step = Math.ceil(simplified.length / maxPoints);
    simplified = simplified.filter((_, i) => i % step === 0);
    if (simplified.length < 3) simplified = open.slice(0, maxPoints);
  }

  // Re-close
  const first = simplified[0];
  const last = simplified[simplified.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1])
    simplified.push([first[0], first[1]]);

  return simplified.length >= 4 ? simplified : null;
}

/**
 * Polyline encoding helpers (Google Encoded Polyline Algorithm).
 * Google expects encoding in lat,lng order.
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
  const ptsLatLng = ringLngLat.map(([lng, lat]) => [lat, lng]);
  return `enc:${encodePolyline(ptsLatLng)}`;
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

function pointInRing(lng, lat, ringLngLat) {
  if (!Array.isArray(ringLngLat) || ringLngLat.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ringLngLat.length - 1; i < ringLngLat.length; j = i++) {
    const xi = ringLngLat[i][0];
    const yi = ringLngLat[i][1];
    const xj = ringLngLat[j][0];
    const yj = ringLngLat[j][1];

    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;

    if (intersects) inside = !inside;
  }
  return inside;
}

function selectBestOverlayRing(overlayRings, parcelRing) {
  if (!Array.isArray(overlayRings) || !overlayRings.length) return null;
  if (!parcelRing || !parcelRing.length) return overlayRings[0];

  const parcelCenter = centroidFromRing(parcelRing);
  if (!parcelCenter) return overlayRings[0];

  const containsHit = overlayRings.find((ring) =>
    pointInRing(parcelCenter.lng, parcelCenter.lat, ring)
  );
  if (containsHit) return containsHit;

  let best = overlayRings[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const ring of overlayRings) {
    const c = centroidFromRing(ring);
    if (!c) continue;
    const dLng = c.lng - parcelCenter.lng;
    const dLat = c.lat - parcelCenter.lat;
    const d2 = dLng * dLng + dLat * dLat;
    if (d2 < bestDist) {
      bestDist = d2;
      best = ring;
    }
  }
  return best;
}

function isImage(resp) {
  const ct = resp?.headers?.["content-type"] || resp?.headers?.["Content-Type"];
  return typeof ct === "string" && ct.toLowerCase().startsWith("image/");
}

function maskKey(url) {
  return String(url).replace(/([?&]key=)[^&]+/i, "$1***");
}

async function fetchStaticMapImageBuffer(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: DEFAULT_TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (resp.status === 200 && isImage(resp) && resp.data) {
    return Buffer.from(resp.data);
  }

  const ct = resp?.headers?.["content-type"] || resp?.headers?.["Content-Type"];
  const bodyPreview =
    typeof resp?.data === "string"
      ? resp.data.slice(0, 180)
      : Buffer.isBuffer(resp?.data)
        ? resp.data.toString("utf8", 0, 180)
        : "";

  console.error("[static-maps] failed", {
    status: resp.status,
    contentType: ct,
    urlLen: String(url).length,
    url: maskKey(url),
    bodyPreview,
  });

  return null;
}

function buildStaticMapUrl({
  apiKey,
  center,
  zoom,
  size,
  scale,
  maptype,
  paths,
  styles,
}) {
  const c = `${center.lat},${center.lng}`;

  let url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?format=png` +
    `&size=${encodeURIComponent(size)}` +
    `&scale=${encodeURIComponent(scale)}` +
    `&maptype=${encodeURIComponent(maptype)}` +
    `&center=${encodeURIComponent(c)}` +
    `&zoom=${encodeURIComponent(zoom)}`;

  if (Array.isArray(styles)) {
    for (const s of styles) url += `&style=${encodeURIComponent(s)}`;
  }

  for (const p of paths) url += `&path=${encodeURIComponent(p)}`;

  url += `&key=${encodeURIComponent(apiKey)}`;
  return url;
}

/**
 * Parcel-only map
 */
export async function getParcelMapImageBufferV2({
  apiKey,
  center,
  zoom = 19, // treated as MAX zoom now
  size = "640x360",
  scale = 2,
  maptype = "hybrid",
  parcelGeoJson,
  paddingPx = 90,
  styles = null,
}) {
  if (!apiKey) {
    console.error("[static-maps] missing apiKey");
    return null;
  }

  const ringRaw = extractPolygonRing(parcelGeoJson);
  if (!ringRaw) return null;

  const bounds = boundsFromRings([ringRaw]);
  const autoCenter = centerFromBounds(bounds) || centroidFromRing(ringRaw);
  const c = center || autoCenter;
  if (!c) return null;

  const fitZoom = fitZoomForBounds({
    bounds,
    size,
    scale,
    paddingPx,
    maxZoom: zoom,
  });

  const parcelPrefix = `fillcolor:0x2ecc7133|color:0x2ecc71ff|weight:4|`;
  const epsList = [0.000003, 0.000008, 0.00002, 0.00005, 0.0001];

  for (const eps of epsList) {
    const simplified = simplifyRing(ringRaw, eps, MAX_RING_POINTS);
    if (!simplified) continue;

    const parcelPath = `${parcelPrefix}${ringToEncodedPath(simplified)}`;

    const url = buildStaticMapUrl({
      apiKey,
      center: { lat: c.lat, lng: c.lng },
      zoom: fitZoom,
      size,
      scale,
      maptype,
      styles,
      paths: [parcelPath],
    });

    if (url.length > MAX_URL_LEN) continue;

    const buf = await fetchStaticMapImageBuffer(url);
    if (buf) return buf;
  }

  const simplified = simplifyRing(ringRaw, 0.0002, 140);
  if (!simplified) return null;

  const url = buildStaticMapUrl({
    apiKey,
    center: { lat: c.lat, lng: c.lng },
    zoom: fitZoom,
    size,
    scale,
    maptype,
    styles,
    paths: [`${parcelPrefix}${ringToEncodedPath(simplified)}`],
  });

  if (url.length > MAX_URL_LEN) return null;
  return fetchStaticMapImageBuffer(url);
}

/**
 * Parcel + overlay map
 */
export async function getParcelOverlayMapImageBufferV2({
  apiKey,
  center,
  zoom = 17, // treated as MAX zoom now
  size = "640x360",
  scale = 2,
  maptype = "hybrid",
  parcelGeoJson,
  overlayGeoJson,
  parcelColor = "0x2ecc71ff",
  parcelFill = "0x2ecc7133",
  parcelWeight = 4,
  overlayColor = "0xff7f00ff",
  overlayFill = "0xff7f0033",
  overlayWeight = 4,
  paddingPx = 110,
  styles = null,
}) {
  if (!apiKey) {
    console.error("[static-maps] missing apiKey");
    return null;
  }

  const parcelRingRaw = extractPolygonRing(parcelGeoJson);
  const overlayRingsRaw = extractPolygonRings(overlayGeoJson);
  const overlayRingRaw = selectBestOverlayRing(overlayRingsRaw, parcelRingRaw);
  if (!parcelRingRaw || !overlayRingRaw) return null;

  const bounds = boundsFromRings([parcelRingRaw, overlayRingRaw]);

  const autoCenter =
    centerFromBounds(bounds) ||
    centroidFromRing(parcelRingRaw) ||
    centroidFromRing(overlayRingRaw);

  const c = center || autoCenter;
  if (!c) return null;

  const fitZoom = fitZoomForBounds({
    bounds,
    size,
    scale,
    paddingPx,
    maxZoom: zoom,
  });

  const parcelPrefix = `fillcolor:${parcelFill}|color:${parcelColor}|weight:${parcelWeight}|`;
  const overlayPrefix = `fillcolor:${overlayFill}|color:${overlayColor}|weight:${overlayWeight}|`;

  const epsList = [0.000005, 0.000015, 0.00004, 0.00008, 0.00016, 0.0003];

  for (const eps of epsList) {
    const parcelRing = simplifyRing(parcelRingRaw, eps, 220);
    const overlayRing = simplifyRing(overlayRingRaw, eps, 220);
    if (!parcelRing || !overlayRing) continue;

    const parcelPath = `${parcelPrefix}${ringToEncodedPath(parcelRing)}`;
    const overlayPath = `${overlayPrefix}${ringToEncodedPath(overlayRing)}`;

    const url = buildStaticMapUrl({
      apiKey,
      center: { lat: c.lat, lng: c.lng },
      zoom: fitZoom,
      size,
      scale,
      maptype,
      styles,
      paths: [parcelPath, overlayPath],
    });

    if (url.length > MAX_URL_LEN) continue;

    const buf = await fetchStaticMapImageBuffer(url);
    if (buf) return buf;
  }

  const parcelRing = simplifyRing(parcelRingRaw, 0.0004, 120);
  const overlayRing = simplifyRing(overlayRingRaw, 0.0004, 120);
  if (!parcelRing || !overlayRing) return null;

  const url = buildStaticMapUrl({
    apiKey,
    center: { lat: c.lat, lng: c.lng },
    zoom: fitZoom,
    size,
    scale,
    maptype,
    styles,
    paths: [
      `${parcelPrefix}${ringToEncodedPath(parcelRing)}`,
      `${overlayPrefix}${ringToEncodedPath(overlayRing)}`,
    ],
  });

  if (url.length > MAX_URL_LEN) return null;
  return fetchStaticMapImageBuffer(url);
}

// Backwards-compatible aliases
export const staticMapParcelOnly = getParcelMapImageBufferV2;
export const staticMapParcelOverlay = getParcelOverlayMapImageBufferV2;
