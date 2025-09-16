// ESM module
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

/**
 * Small helper to run a command and stream logs to stdout/stderr.
 */
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

// Example env (you already set these in Render):
// FACE_SWAP_CMD=python3 -m facefusion
// FACE_SWAP_ARGS_BASE=--headless --execution-provider cpu --face-selector-mode best --seamless --face-enhancer codeformer --color-transfer strong
const FACE_SWAP_CMD =
  process.env.FACE_SWAP_CMD?.trim() || "python3 -m facefusion";
const FACE_SWAP_ARGS_BASE = (process.env.FACE_SWAP_ARGS_BASE || "")
  .split(/\s+/)
  .filter(Boolean);

/**
 * swapFaceOnVideo
 * @param {Object} p
 * @param {Buffer} p.faceBytes - user's uploaded face image bytes (JPEG/PNG ok)
 * @param {string} p.baseVideoUrl - public URL of the article teaser video
 * @param {string[]} [p.extraArgs] - optional extra CLI flags
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function swapFaceOnVideo({
  faceBytes,
  baseVideoUrl,
  extraArgs = [],
}) {
  if (!faceBytes || !Buffer.isBuffer(faceBytes)) {
    throw new Error("swapFaceOnVideo: faceBytes (Buffer) is required");
  }
  if (!baseVideoUrl || typeof baseVideoUrl !== "string") {
    throw new Error("swapFaceOnVideo: baseVideoUrl (string) is required");
  }

  // Prepare temp paths
  await fs.mkdir(TMP_DIR, { recursive: true });
  const ts = Date.now();
  const facePath = path.join(TMP_DIR, `face_${ts}.jpg`);
  const inVideoPath = path.join(TMP_DIR, `in_${ts}.mp4`);
  const outVideoPath = path.join(TMP_DIR, `out_${ts}.mp4`);

  // Write face image
  await fs.writeFile(facePath, faceBytes);

  // Download base video
  const resp = await fetch(baseVideoUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch base video (${resp.status})`);
  }
  const ab = await resp.arrayBuffer();
  await fs.writeFile(inVideoPath, Buffer.from(ab));

  // Parse command + args
  const parts = FACE_SWAP_CMD.split(/\s+/).filter(Boolean);
  const cmd = parts.shift();
  if (!cmd) throw new Error("FACE_SWAP_CMD is empty");

  const args = [
    ...parts,
    ...FACE_SWAP_ARGS_BASE,
    // Common FaceFusion CLI flags (these work across versions/forks that keep the --source/--target/--output contract)
    "--source",
    facePath,
    "--target",
    inVideoPath,
    "--output",
    outVideoPath,
    ...extraArgs,
  ];

  // Run FaceFusion
  await run(cmd, args, {
    env: {
      ...process.env,
      // ensure caches go to persistent paths if you mounted a disk
      FACEFUSION_CACHE_DIR: process.env.FACEFUSION_CACHE_DIR || "/cache",
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || "/cache/xdg",
      HF_HOME: process.env.HF_HOME || "/cache/hf",
      INSIGHTFACE_HOME: process.env.INSIGHTFACE_HOME || "/cache/insightface",
    },
  });

  // Read output video
  const out = await fs.readFile(outVideoPath);

  // Best-effort cleanup (keep it simple; /tmp is ephemeral in containers)
  try {
    await fs.unlink(facePath);
    await fs.unlink(inVideoPath);
    await fs.unlink(outVideoPath);
  } catch {}

  return { bytes: out, mime: "video/mp4" };
}

// also export default so both `import { swapFaceOnVideo } ...` and `import swapFaceOnVideo ...` work
export default swapFaceOnVideo;
