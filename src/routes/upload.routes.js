import express from "express";
import { signPutUrl } from "../services/s3.js"; // the helper from s3.js
// import { authRequired } from '../middlewares/authJwt.js';

const router = express.Router();

const REGION =
  process.env.S3_REGION || process.env.AWS_REGION || "ap-southeast-2";
const BUCKET = process.env.S3_BUCKET;
const PUBLIC_BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;

router.post(
  "/uploads/presign",
  /*authRequired,*/ async (req, res, next) => {
    try {
      const {
        filename = "upload.bin",
        contentType = "application/octet-stream",
        folder = "users",
      } = req.body || {};
      const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, "-");
      const ext = safe.includes(".") ? safe.slice(safe.lastIndexOf(".")) : "";
      const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const uploadUrl = await signPutUrl(key, contentType, 60);
      const publicUrl = `${PUBLIC_BASE}/${encodeURI(key)}`;
      res.json({ uploadUrl, objectKey: key, publicUrl, expiresIn: 60 });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
