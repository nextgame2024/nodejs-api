import { signGetUrl } from "./s3.js";

const RUNPOD_URL = process.env.RUNPOD_URL; // e.g. "https://XYZ-abc.runpod.run" or full http://IP:8080
const RUNPOD_TOKEN = process.env.RUNPOD_TOKEN || ""; // matches API_TOKEN in the pod
const TIMEOUT_MS = Number(process.env.POD_TIMEOUT_MS || 15 * 60_000); // 15 min for long videos

function ensureUrl(u) {
  if (!u || !/^https?:\/\//i.test(u))
    throw new Error("RUNPOD_URL must be http(s)");
  return u.replace(/\/+$/, "");
}

/**
 * Swap face on a video by calling the RunPod FastAPI.
 * @param {Object} p
 * @param {string} p.faceKey - S3 key for the user's headshot
 * @param {string} p.videoKey - S3 key for the base article video
 * @param {string[]} [p.extraArgs] - future passthrough (not used by server.py yet)
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function swapFaceOnVideoViaPod({
  faceKey,
  videoKey,
  extraArgs = [],
}) {
  if (!faceKey || !videoKey)
    throw new Error("faceKey and videoKey are required");
  const base = ensureUrl(RUNPOD_URL);

  // presigned GET URLs that the pod can fetch
  const faceUrl = await signGetUrl(faceKey, 3600); // 1h
  const videoUrl = await signGetUrl(videoKey, 3600);

  // form-data (URLs) — lets pod download directly (no buffering in worker)
  const form = new FormData();
  form.set("face_url", faceUrl);
  form.set("video_url", videoUrl);
  // If you later extend server.py to accept "extra_args", pass JSON:
  // form.set("extra_args", JSON.stringify(extraArgs));

  const resp = await fetch(`${base}/swap`, {
    method: "POST",
    headers: {
      ...(RUNPOD_TOKEN ? { Authorization: `Bearer ${RUNPOD_TOKEN}` } : {}),
    },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(
      `RunPod swap failed (${resp.status}): ${txt.slice(0, 500)}`
    );
  }

  const ab = await resp.arrayBuffer();
  return {
    bytes: Buffer.from(ab),
    mime: resp.headers.get("content-type") || "video/mp4",
  };
}

export default swapFaceOnVideoViaPod;
