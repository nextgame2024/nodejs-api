import { signGetUrl, signPutUrl } from "./s3.js";

/**
 * RunPod Serverless client for face-swap worker.
 * Requires:
 *   RUNPOD_ENDPOINT_ID   - your serverless endpoint ID (not the image name)
 *   RUNPOD_API_KEY       - RunPod API key (Bearer)
 * Optional:
 *   RP_POLL_MS           - polling interval (ms) [default 3000]
 *   RP_TIMEOUT_MS        - overall timeout (ms) [default 20 minutes]
 */
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const API_KEY = process.env.RUNPOD_API_KEY;

const POLL_MS = Number(process.env.RP_POLL_MS || 3000);
const TIMEOUT_MS = Number(process.env.RP_TIMEOUT_MS || 20 * 60_000);

function assertEnv() {
  if (!ENDPOINT_ID) throw new Error("RUNPOD_ENDPOINT_ID env var is required");
  if (!API_KEY) throw new Error("RUNPOD_API_KEY env var is required");
}

async function rpRun(input) {
  assertEnv();
  const url = `https://api.runpod.ai/v2/${ENDPOINT_ID}/run`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`RunPod run failed (${resp.status}): ${txt.slice(0, 500)}`);
  }
  const data = await resp.json();
  // data: { id, status, ... } (status may be IN_QUEUE / IN_PROGRESS)
  return data?.id;
}

async function rpPoll(jobId, signal) {
  assertEnv();
  const url = `https://api.runpod.ai/v2/${ENDPOINT_ID}/status/${jobId}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(
      `RunPod status failed (${resp.status}): ${txt.slice(0, 500)}`
    );
  }
  return await resp.json();
}

/**
 * Submit a serverless job and wait for completion.
 * @param {Object} p
 * @param {string} p.jobId - your internal render_jobs.id (used to name the output key)
 * @param {string} p.faceKey - S3 key of user's headshot (private)
 * @param {string} p.videoKey - S3 key of base article video (private)
 * @param {number} [p.scale] - optional SWAP_SCALE override
 * @param {number} [p.frameStride] - optional SWAP_FRAME_STRIDE override
 * @param {number} [p.maxFrames] - optional SWAP_MAX_FRAMES override
 * @returns {Promise<{ outKey: string, signedUrl: string | null }>}
 */
export async function swapFaceViaServerless({
  jobId,
  faceKey,
  videoKey,
  scale,
  frameStride,
  maxFrames,
}) {
  if (!jobId) throw new Error("jobId is required");
  if (!faceKey || !videoKey)
    throw new Error("faceKey and videoKey are required");

  // Where we want the worker to upload the final MP4
  const outKey = `renders/${jobId}/output.mp4`;

  // Pre-sign inputs (GET) and output (PUT)
  const [faceUrl, videoUrl, outputPutUrl] = await Promise.all([
    signGetUrl(faceKey, 3600),
    signGetUrl(videoKey, 3600),
    signPutUrl(outKey, "video/mp4", 3600),
  ]);

  // Compose worker input (matches handler.py)
  const input = {
    face_url: faceUrl,
    video_url: videoUrl,
    output_put_url: outputPutUrl,
  };
  if (scale !== undefined) input.swap_scale = Number(scale);
  if (frameStride !== undefined) input.frame_stride = Number(frameStride);
  if (maxFrames !== undefined) input.max_frames = Number(maxFrames);

  const id = await rpRun(input);

  // Poll until COMPLETED / FAILED / CANCELLED
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const status = await rpPoll(id, ctrl.signal);

      // Typical payloads:
      // { status: 'IN_QUEUE'|'IN_PROGRESS'|'COMPLETED'|'FAILED'|'CANCELLED', output, error, ... }
      const st = status?.status;
      if (st === "COMPLETED") {
        // Our worker uploaded to S3; return a signed GET for convenience
        const signedUrl = await signGetUrl(outKey);
        return { outKey, signedUrl };
      }
      if (st === "FAILED" || st === "CANCELLED") {
        const msg =
          status?.error || status?.output?.error || JSON.stringify(status);
        throw new Error(`RunPod job ${st}: ${msg}`);
      }
      // else keep polling (IN_QUEUE / IN_PROGRESS)
    }
  } finally {
    clearTimeout(timer);
  }
}
