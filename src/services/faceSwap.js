import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/** Run a command and stream output */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      ...opts,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(`Command failed: ${cmd} ${args.join(" ")} (code ${code})`)
      );
    });
  });
}

const TMP_DIR = process.env.TMPDIR || "/tmp";

// Example env in Render:
const DEFAULT_FACE_SWAP_ARGS_BASE =
  "--headless --execution-provider cpu --face-selector-mode best --seamless --face-enhancer codeformer --color-transfer strong";
const DEFAULT_CMD = "python3 -m facefusion";
const FACE_SWAP_CMD = process.env.FACE_SWAP_CMD?.trim() || DEFAULT_CMD;
const FACE_SWAP_ARGS_BASE = (
  process.env.FACE_SWAP_ARGS_BASE || DEFAULT_FACE_SWAP_ARGS_BASE
)
  .split(/\s+/)
  .filter(Boolean);
const FACEFUSION_CWD = process.env.FACEFUSION_CWD || "/opt/facefusion";

/**
 * swapFaceOnVideo
 * @param {Object} p
 * @param {Buffer} p.faceBytes                 User photo bytes (PNG/JPEG).
 * @param {string} [p.baseVideoUrl]            Public/presigned URL to base video.
 * @param {Buffer} [p.baseVideoBytes]          Base video bytes (alternative to URL).
 * @param {string[]} [p.extraArgs]             Extra FaceFusion CLI flags.
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function swapFaceOnVideo({
  faceBytes,
  baseVideoUrl,
  baseVideoBytes,
  extraArgs = [],
}) {
  if (!faceBytes || !Buffer.isBuffer(faceBytes)) {
    throw new Error("swapFaceOnVideo: faceBytes (Buffer) is required");
  }
  if (!baseVideoUrl && !baseVideoBytes) {
    throw new Error(
      "swapFaceOnVideo: baseVideoUrl or baseVideoBytes is required"
    );
  }

  await fs.mkdir(TMP_DIR, { recursive: true });
  const ts = Date.now();
  const facePath = path.join(TMP_DIR, `face_${ts}.jpg`);
  const inVideoPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outVideoPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  // 1) Write face image
  await fs.writeFile(facePath, faceBytes);

  // 2) Prepare base video (download or write bytes)
  if (baseVideoBytes && Buffer.isBuffer(baseVideoBytes)) {
    await fs.writeFile(inVideoPath, baseVideoBytes);
  } else {
    const resp = await fetch(baseVideoUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch base video (${resp.status})`);
    }
    const ab = await resp.arrayBuffer();
    await fs.writeFile(inVideoPath, Buffer.from(ab));
  }

  let cmdString = FACE_SWAP_CMD;
  if (/run\.py/.test(cmdString)) {
    try {
      await fs.access("/opt/facefusion/run.py");
    } catch {
      console.warn(
        '[FaceSwap] FACE_SWAP_CMD points to run.py but file is missing; falling back to "python3 -m facefusion".'
      );
      cmdString = DEFAULT_CMD;
    }
  }

  // 3) Parse command + args
  const parts = cmdString.split(/\s+/).filter(Boolean);
  const cmd = parts.shift();
  if (!cmd) throw new Error("FACE_SWAP_CMD is empty");

  const args = [
    ...parts,
    ...FACE_SWAP_ARGS_BASE,
    "--source",
    facePath,
    "--target",
    inVideoPath,
    "--output",
    outVideoPath,
    ...extraArgs,
  ];

  // 4) Run FaceFusion
  await run(cmd, args, {
    cwd: FACEFUSION_CWD,
    env: {
      ...process.env,
      FACEFUSION_CACHE_DIR: process.env.FACEFUSION_CACHE_DIR || "/cache",
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || "/cache/xdg",
      HF_HOME: process.env.HF_HOME || "/cache/hf",
      INSIGHTFACE_HOME: process.env.INSIGHTFACE_HOME || "/cache/insightface",
    },
  });

  // 4.1) Make sure FaceFusion actually produced an output
  const produced = await fs
    .stat(outVideoPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (!produced) {
    throw new Error("FaceFusion didn’t produce an output video");
  }

  // 5) Read output
  const out = await fs.readFile(outVideoPath);

  // Cleanup (best effort)
  try {
    await fs.unlink(facePath);
    await fs.unlink(inVideoPath);
    await fs.unlink(outVideoPath);
  } catch {}

  return { bytes: out, mime: "video/mp4" };
}

export default swapFaceOnVideo;
