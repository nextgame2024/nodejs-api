import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/** Run a command and stream output */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
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

/** Low-RAM defaults; override via Render env if needed */
const FACEFUSION_CWD = process.env.FACEFUSION_CWD || "/opt/facefusion";
const FACE_SWAP_CMD = (
  process.env.FACE_SWAP_CMD || "python3 /opt/facefusion/facefusion.py"
).trim();
const FACEFUSION_SUBCOMMAND = (
  process.env.FACEFUSION_SUBCOMMAND || "headless-run"
).trim(); // or "run"
const EXECUTION_PROVIDERS = (process.env.FACEFUSION_PROVIDERS || "cpu")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const THREADS = process.env.FACEFUSION_THREADS || "1";

/** The new CLI only accepts many|one|reference */
const FACE_SELECTOR_MODE = (process.env.FACE_SELECTOR_MODE || "one").trim();
const FACE_SELECTOR_ORDER = (
  process.env.FACE_SELECTOR_ORDER || "best-worst"
).trim();

const FACE_SWAPPER_MODEL = process.env.FACE_SWAPPER_MODEL || "inswapper_128";

/** Optional enhancer (turn on only if you have RAM for it) */
const ENABLE_ENHANCER = (process.env.FACEFUSION_ENABLE_ENHANCER || "0") === "1";
const FACE_ENHANCER_MODEL = process.env.FACE_ENHANCER_MODEL || "codeformer";

/**
 * swapFaceOnVideo
 * @param {Object} p
 * @param {Buffer} p.faceBytes
 * @param {string} [p.baseVideoUrl]
 * @param {Buffer} [p.baseVideoBytes]
 * @param {string[]} [p.extraArgs]
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

  // Write inputs
  await fs.writeFile(facePath, faceBytes);
  if (baseVideoBytes && Buffer.isBuffer(baseVideoBytes)) {
    await fs.writeFile(inVideoPath, baseVideoBytes);
  } else {
    const resp = await fetch(baseVideoUrl);
    if (!resp.ok)
      throw new Error(`Failed to fetch base video (${resp.status})`);
    const ab = await resp.arrayBuffer();
    await fs.writeFile(inVideoPath, Buffer.from(ab));
  }

  const processors = ["face_swapper"];
  if (ENABLE_ENHANCER) processors.push("face_enhancer");

  const parts = FACE_SWAP_CMD.split(/\s+/).filter(Boolean);
  const cmd = parts.shift();
  if (!cmd) throw new Error("FACE_SWAP_CMD is empty");

  const args = [
    ...parts,
    FACEFUSION_SUBCOMMAND, // "headless-run"
    "--execution-providers",
    ...EXECUTION_PROVIDERS,
    "--execution-thread-count",
    THREADS,

    // NEW: valid selector options in latest CLI
    "--face-selector-mode",
    FACE_SELECTOR_MODE, // many|one|reference
    "--face-selector-order",
    FACE_SELECTOR_ORDER, // best-worst, left-right, etc.

    "--processors",
    ...processors,
    "--face-swapper-model",
    FACE_SWAPPER_MODEL,
    ...(ENABLE_ENHANCER ? ["--face-enhancer-model", FACE_ENHANCER_MODEL] : []),

    // Canonical flags for headless-run
    "-s",
    facePath,
    "-t",
    inVideoPath,
    "-o",
    outVideoPath,

    ...extraArgs,
  ];

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

  const ok = await fs
    .stat(outVideoPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (!ok) throw new Error("FaceFusion didn’t produce an output video");

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
