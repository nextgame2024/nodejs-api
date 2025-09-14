import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getJobById } from "../models/render.model.js";
import { signGetUrl } from "../services/s3.js";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getJobById } from "../models/render.model.js";
import { getArticleSlugById } from "../models/article.model.js";

// GET /api/renders/:id
export const getRenderStatus = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const job = await getJobById(id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  // If soft-deleted or expired, return 410 Gone (explicit)
  const now = Date.now();
  if (
    job.deleted_at ||
    (job.expires_at && new Date(job.expires_at).getTime() < now)
  ) {
    return res.status(410).json({ error: "Expired" });
  }

  const articleSlug = job.article_id
    ? await getArticleSlugById(job.article_id)
    : null;

  let signedUrl = null;
  if (job.status === "done" && job.output_video_key) {
    // 6h signed URL by default (see s3.js)
    signedUrl = await signGetUrl(job.output_video_key);
  }

  res.json({
    id: job.id,
    status: job.status,
    expiresAt: job.expires_at,
    articleId: job.article_id,
    articleSlug,
    signedUrl,
  });
});
