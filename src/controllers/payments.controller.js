import Stripe from "stripe";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import {
  createRenderJob,
  setJobAwaitingPayment,
  markJobPaid,
} from "../models/render.model.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
const bucket = process.env.S3_BUCKET;

const PRICE_AUD_CENTS = Number(process.env.PRICE_AUD_CENTS || 399);
const CURRENCY = "aud";

/** POST /api/renders/create-session
 *  Body: { filename, contentType }
 *  Returns: { jobId, uploadUrl, sessionUrl }
 */
export const createRenderSession = async (req, res, next) => {
  try {
    const { filename, contentType } = req.body || {};
    if (!filename || !contentType) {
      return res.status(400).json({ error: "filename & contentType required" });
    }
    // Basic allow-list to avoid weird uploads
    if (!/^image\//.test(contentType)) {
      return res.status(400).json({ error: "Only image uploads are allowed" });
    }

    const jobId = randomUUID();
    const ext = (filename.split(".").pop() || "jpg").toLowerCase();
    const key = `renders/${jobId}/source.${ext}`;

    // 1) Presigned PUT URL (10 minutes)
    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 600 });

    // 2) DB job
    await createRenderJob({
      id: jobId,
      imageKey: key,
      imageMime: contentType,
      amountCents: PRICE_AUD_CENTS,
      currency: CURRENCY,
    });

    // 3) Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"], // Apple/Google Pay auto-enabled
      line_items: [
        {
          price_data: {
            currency: CURRENCY,
            unit_amount: PRICE_AUD_CENTS,
            product_data: { name: "sophiaAi video effect" },
          },
          quantity: 1,
        },
      ],
      metadata: { jobId },
      success_url: `${process.env.CLIENT_URL}/checkout/success?jobId=${jobId}`,
      cancel_url: `${process.env.CLIENT_URL}/checkout/cancel?jobId=${jobId}`,
    });

    await setJobAwaitingPayment(jobId, session.id);

    return res.json({ jobId, uploadUrl, sessionUrl: session.url });
  } catch (err) {
    next(err);
  }
};

/** POST /api/webhooks/stripe  (raw body required) */
export const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, // raw buffer (mounted with express.raw)
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Stripe webhook signature failed:", err.message);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const jobId = session.metadata?.jobId;
    try {
      if (jobId) {
        await markJobPaid(jobId, session.payment_intent?.toString() || null);
        // TODO: enqueue your Veo render here using jobId
      }
    } catch (e) {
      console.error("Webhook processing error:", e?.message || e);
      // return 200 to stop Stripe retries; handle retry in your worker if needed
    }
  }

  res.json({ received: true });
};
