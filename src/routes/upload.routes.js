import express from "express";
import { signPutUrl } from "../services/s3.js"; // existing helper
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
// import { authRequired } from "../middlewares/authJwt.js";

const router = express.Router();

const REGION =
  process.env.S3_REGION || process.env.AWS_REGION || "ap-southeast-2";
const BUCKET = process.env.S3_BUCKET;
const PUBLIC_BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

/**
 * POST /api/uploads/presign
 * body:
 *   - filename: string
 *   - contentType?: string
 *   - folder?: string            (default: "public/avatars")
 *   - strategy?: "post"|"put"    (default: "post" for browsers)
 *
 * Returns (POST strategy):
 *   { method:"POST", postUrl, fields, objectKey, publicUrl, expiresIn }
 *
 * Returns (PUT strategy, legacy):
 *   { method:"PUT", uploadUrl, objectKey, publicUrl, expiresIn }
 */
router.post(
  "/uploads/presign",
  /*authRequired,*/ async (req, res, next) => {
    try {
      const {
        filename = "upload.bin",
        contentType = "application/octet-stream",
        // put avatars under an already-public prefix to match your bucket policy
        folder = "public/avatars",
        strategy = "post", // default to POST for browsers
      } = req.body || {};

      const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, "-");
      const ext = safe.includes(".") ? safe.slice(safe.lastIndexOf(".")) : "";
      const key = `${folder}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}${ext}`;

      const ttl = 60;

      if (strategy === "put") {
        // Legacy presigned PUT (may be affected by SDK checksum middleware on some setups)
        const uploadUrl = await signPutUrl(key, contentType, ttl);
        const publicUrl = `${PUBLIC_BASE}/${encodeURI(key)}`;
        return res.json({
          method: "PUT",
          uploadUrl,
          objectKey: key,
          publicUrl,
          expiresIn: ttl,
        });
      }

      const { url: postUrl, fields } = await createPresignedPost(s3, {
        Bucket: BUCKET,
        Key: key,
        Expires: ttl, // seconds
        Conditions: [
          ["content-length-range", 0, 5 * 1024 * 1024], // up to 5 MB
          ["starts-with", "$Content-Type", "image/"], // images only
          ["eq", "$key", key],
        ],
        Fields: {
          "Content-Type": contentType,
        },
      });

      const publicUrl = `${PUBLIC_BASE}/${encodeURI(key)}`;
      return res.json({
        method: "POST",
        postUrl,
        fields,
        objectKey: key,
        publicUrl,
        expiresIn: ttl,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
