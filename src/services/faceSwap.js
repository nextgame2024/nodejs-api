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

const DEFAULT_ARGS =
  "--processors face_swapper face_enhancer --face-swapper-model inswapper_128 --face-enhancer-model codeformer --execution-providers cpu--processors face_swapper face_enhancer --face-swapper-model inswapper_128 --face-enhancer-model codeformer --execution-providers cpu";

const FACE_SWAP_ARGS_BASE = (process.env.FACE_SWAP_ARGS_BASE || DEFAULT_ARGS)
  .split(/\s+/)
  .filter(Boolean);

const FACEFUSION_CWD = process.env.FACEFUSION_CWD || "/opt/facefusion";
const FACE_SWAP_CMD =
  (process.env.FACE_SWAP_CMD && process.env.FACE_SWAP_CMD.trim()) ||
  "python3 /opt/facefusion/facefusion.py";

/**
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

  // Inputs
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

  // Build args: subcommand FIRST, then options
  const baseCmdParts = FACE_SWAP_CMD.split(/\s+/).filter(Boolean);
  const cmd = baseCmdParts.shift();
  if (!cmd) throw new Error("FACE_SWAP_CMD is empty");

  const args = [
    ...baseCmdParts,
    "run",
    ...FACE_SWAP_ARGS_BASE,
    "--source",
    facePath,
    "--target",
    inVideoPath,
    "--output-path",
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
  try {
    await fs.unlink(facePath);
    await fs.unlink(inVideoPath);
    await fs.unlink(outVideoPath);
  } catch {}
  return { bytes: out, mime: "video/mp4" };
}

export default swapFaceOnVideo;
