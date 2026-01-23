// googleStaticMaps_v2.service.js
import axios from "axios";

const MAX_URL_LEN = 7600; // conservative under typical 8KB proxy limits
const MAX_RING_POINTS = 240; // keep paths small and reliable
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Extract outer ring (array of [lng,lat]) from GeoJSON Feature/Geometry.
 * Supports Polygon and MultiPolygon (chooses the largest outer ring).
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

  // Diagnostic (do not log full key)
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
  paths, // array of encoded path strings already style-prefixed
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

  for (const p of paths) url += `&path=${encodeURIComponent(p)}`;

  url += `&key=${encodeURIComponent(apiKey)}`;
  return url;
}

/**
 * Attempt multiple simplification levels until URL length is safe.
 */
function buildPathWithBackoff({
  ringLngLat,
  stylePrefix, // e.g. "fillcolor:...|color:...|weight:4|"
  epsilonCandidates,
  maxPoints = MAX_RING_POINTS,
}) {
  for (const eps of epsilonCandidates) {
    const simplified = simplifyRing(ringLngLat, eps, maxPoints);
    if (!simplified) continue;
    const enc = ringToEncodedPath(simplified);
    const path = `${stylePrefix}${enc}`;
    // caller checks URL length; we just return best first
    return { path, simplifiedPoints: simplified.length };
  }
  return { path: null, simplifiedPoints: 0 };
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
  parcelGeoJson,
}) {
  if (!apiKey) {
    console.error("[static-maps] missing apiKey");
    return null;
  }

  const ringRaw = extractPolygonRing(parcelGeoJson);
  if (!ringRaw) return null;

  const c = center || centroidFromRing(ringRaw);
  if (!c) return null;

  const parcelPrefix = `fillcolor:0x2ecc7133|color:0x2ecc71ff|weight:4|`;

  // try small epsilon first; increase if needed
  const epsList = [0.000003, 0.000008, 0.00002, 0.00005, 0.0001];

  let best = null;

  for (const eps of epsList) {
    const simplified = simplifyRing(ringRaw, eps, MAX_RING_POINTS);
    if (!simplified) continue;

    const parcelPath = `${parcelPrefix}${ringToEncodedPath(simplified)}`;

    const url = buildStaticMapUrl({
      apiKey,
      center: { lat: c.lat, lng: c.lng },
      zoom,
      size,
      scale,
      maptype,
      paths: [parcelPath],
    });

    if (url.length > MAX_URL_LEN) continue;

    best = await fetchStaticMapImageBuffer(url);
    if (best) return best;
  }

  // If URL length was always too big, last resort: force coarse simplification + fewer points
  const simplified = simplifyRing(ringRaw, 0.0002, 140);
  if (!simplified) return null;

  const url = buildStaticMapUrl({
    apiKey,
    center: { lat: c.lat, lng: c.lng },
    zoom,
    size,
    scale,
    maptype,
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
  zoom = 17,
  size = "640x360",
  scale = 2,
  maptype = "hybrid",
  parcelGeoJson,
  overlayGeoJson,
  overlayColor = "0xff7f00ff",
  overlayFill = "0xff7f0033",
}) {
  if (!apiKey) {
    console.error("[static-maps] missing apiKey");
    return null;
  }

  const parcelRingRaw = extractPolygonRing(parcelGeoJson);
  const overlayRingRaw = extractPolygonRing(overlayGeoJson);
  if (!parcelRingRaw || !overlayRingRaw) return null;

  const c =
    center ||
    centroidFromRing(parcelRingRaw) ||
    centroidFromRing(overlayRingRaw);
  if (!c) return null;

  const parcelPrefix = `fillcolor:0x2ecc7133|color:0x2ecc71ff|weight:4|`;
  const overlayPrefix = `fillcolor:${overlayFill}|color:${overlayColor}|weight:4|`;

  // overlay often has more points; back off more aggressively
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
      zoom,
      size,
      scale,
      maptype,
      paths: [parcelPath, overlayPath],
    });

    if (url.length > MAX_URL_LEN) continue;

    const buf = await fetchStaticMapImageBuffer(url);
    if (buf) return buf;
  }

  // last resort: fewer points
  const parcelRing = simplifyRing(parcelRingRaw, 0.0004, 120);
  const overlayRing = simplifyRing(overlayRingRaw, 0.0004, 120);
  if (!parcelRing || !overlayRing) return null;

  const url = buildStaticMapUrl({
    apiKey,
    center: { lat: c.lat, lng: c.lng },
    zoom,
    size,
    scale,
    maptype,
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
