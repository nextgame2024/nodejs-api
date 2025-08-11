import { Router } from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const router = Router();

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

// POST /api/uploads/presign
router.post("/uploads/presign", async (req, res, next) => {
  try {
    const { filename, contentType } = req.body || {};
    if (!filename || !contentType) {
      return res
        .status(400)
        .json({ error: "filename and contentType required" });
    }

    const safeName = filename.replace(/[^\w.\-]/g, "_");
    const key = `users/${Date.now()}-${safeName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      // No ACL needed (Bucket owner enforced)
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 }); // 60 seconds
    const publicUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
    res.json({ uploadUrl, objectKey: key, publicUrl });
  } catch (err) {
    next(err);
  }
});

export default router;
