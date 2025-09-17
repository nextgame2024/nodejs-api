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
  "--headless --execution-provider cpu --face-selector-mode best --seamless --face-enhancer codeformer --color-transfer strong";
const FACE_SWAP_ARGS_BASE = (process.env.FACE_SWAP_ARGS_BASE || DEFAULT_ARGS)
  .split(/\s+/)
  .filter(Boolean);

const FACEFUSION_CWD = process.env.FACEFUSION_CWD || "/opt/facefusion";
/** Default to the script we actually have in your image */
const FACE_SWAP_CMD =
  process.env.FACE_SWAP_CMD?.trim() || "python3 /opt/facefusion/facefusion.py";

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

  // Build candidate commands
  const tail = [
    ...FACE_SWAP_ARGS_BASE,
    "--source",
    facePath,
    "--target",
    inVideoPath,
    "--output",
    outVideoPath,
    ...extraArgs,
  ];

  const candidates = [];
  const push = (cmdStr, prefixArgs = []) => {
    const parts = cmdStr.split(/\s+/).filter(Boolean);
    const cmd = parts.shift();
    if (cmd) candidates.push({ cmd, args: [...parts, ...prefixArgs, ...tail] });
  };

  // Prefer the file you actually have: facefusion.py (with/without "run")
  push(FACE_SWAP_CMD, ["run"]);
  push(FACE_SWAP_CMD);

  // Fallbacks in case ENV was changed
  push("python3 /opt/facefusion/facefusion.py", ["run"]);
  push("python3 /opt/facefusion/facefusion.py");

  // Other historical launchers (may not exist in your checkout)
  push("python3 -m facefusion");
  push("python3 /opt/facefusion/run.py");
  push("/opt/ffenv/bin/python3 /opt/facefusion/facefusion.py");
  push("/opt/ffenv/bin/python3 -m facefusion");
  push("/opt/ffenv/bin/python3 /opt/facefusion/run.py");

  // Try until one works
  let lastErr;
  for (const c of candidates) {
    try {
      await run(c.cmd, c.args, {
        cwd: FACEFUSION_CWD,
        env: {
          ...process.env,
          FACEFUSION_CACHE_DIR: process.env.FACEFUSION_CACHE_DIR || "/cache",
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || "/cache/xdg",
          HF_HOME: process.env.HF_HOME || "/cache/hf",
          INSIGHTFACE_HOME:
            process.env.INSIGHTFACE_HOME || "/cache/insightface",
        },
      });
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[FaceSwap] Candidate failed: ${c.cmd} ${c.args.join(" ")}`);
    }
  }
  if (lastErr) {
    try {
      const entries = await fs.readdir("/opt/facefusion");
      console.warn(
        `[FaceSwap] /opt/facefusion entries: ${entries.slice(0, 80).join(", ")}`
      );
    } catch {}
    throw lastErr;
  }

  // Ensure output exists
  const ok = await fs
    .stat(outVideoPath)
    .then((s) => s.isFile() && s.size > 0)
    .catch(() => false);
  if (!ok) throw new Error("FaceFusion didn’t produce an output video");

  // Read & cleanup
  const out = await fs.readFile(outVideoPath);
  try {
    await fs.unlink(facePath);
    await fs.unlink(inVideoPath);
    await fs.unlink(outVideoPath);
  } catch {}
  return { bytes: out, mime: "video/mp4" };
}

export default swapFaceOnVideo;
