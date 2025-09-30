import express from "express";
import { signPutUrl } from "../services/s3.js"; // reuse your helper
// import { authRequired } from '../middlewares/authJwt.js'; // uncomment if you already protect this route

const router = express.Router();

const REGION =
  process.env.S3_REGION || process.env.AWS_REGION || "ap-southeast-2";
const BUCKET = process.env.S3_BUCKET;
const PUBLIC_BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;

/**
 * POST /api/uploads/presign
 * body: { filename: string, contentType?: string, folder?: string }
 * returns: { uploadUrl, objectKey, publicUrl, expiresIn }
 */
router.post(
  "/uploads/presign",
  /*authRequired,*/ async (req, res, next) => {
    try {
      const {
        filename = "upload.bin",
        contentType = "application/octet-stream",
        folder = "users",
      } = req.body || {};

      // sanitize filename, keep extension if present
      const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, "-");
      const ext = safe.includes(".") ? safe.slice(safe.lastIndexOf(".")) : "";
      const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

      // Presign using the shared helper (no checksum fields added)
      const uploadUrl = await signPutUrl(key, contentType, 60); // 60s TTL

      const publicUrl = `${PUBLIC_BASE}/${encodeURI(key)}`;
      res.json({ uploadUrl, objectKey: key, publicUrl, expiresIn: 60 });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
