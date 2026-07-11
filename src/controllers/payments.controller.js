// payments.controller.js
import Stripe from "stripe";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import {
  createRenderJob,
  setJobAwaitingPayment,
  markJobPaid,
  findArticleIdBySlug,
} from "../models/render.model.js";
import {
  createAiToolkitPayment,
  markAiToolkitPaymentAwaitingCheckout,
  markAiToolkitPaymentPaidBySession,
  getAiToolkitPaymentBySession,
  userHasPaidAiToolkit,
  ensureAiToolkitDashboardNavigationLinkForUser,
} from "../models/aiToolkitPayment.model.js";

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
const AI_TOOLKIT_PRICE_AUD_CENTS = Number(
  process.env.AI_TOOLKIT_PRICE_AUD_CENTS || 900
);
const CURRENCY = "aud";

/** Body: { filename, contentType, articleSlug, guestEmail? } */
export const createRenderSession = async (req, res, next) => {
  try {
    const { filename, contentType, articleSlug, guestEmail } = req.body || {};
    if (!filename || !contentType || !articleSlug) {
      return res
        .status(400)
        .json({ error: "filename, contentType, articleSlug required" });
    }
    if (!/^image\//.test(contentType)) {
      return res.status(400).json({ error: "Only image uploads are allowed" });
    }
    // if guest email provided, very light validation
    if (guestEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const userId = req.user?.id || null;
    const articleId = await findArticleIdBySlug(articleSlug);
    if (!articleId) return res.status(404).json({ error: "Article not found" });

    const jobId = randomUUID();
    const ext = (filename.split(".").pop() || "jpg").toLowerCase();
    const key = `renders/${jobId}/source.${ext}`;

    // Presigned PUT for source image
    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 600 });

    // DB job
    await createRenderJob({
      id: jobId,
      imageKey: key,
      imageMime: contentType,
      amountCents: PRICE_AUD_CENTS,
      currency: CURRENCY,
      userId,
      guestEmail: guestEmail || null,
      articleId,
    });

    // Stripe Checkout
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"], // wallets enabled automatically
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
      metadata: { jobId, articleSlug },
      success_url: `${process.env.CLIENT_URL}/checkout/success?jobId=${jobId}&article=${encodeURIComponent(articleSlug)}`,
      cancel_url: `${process.env.CLIENT_URL}/checkout/cancel?jobId=${jobId}&article=${encodeURIComponent(articleSlug)}`,
    });

    await setJobAwaitingPayment(jobId, session.id);
    return res.json({ jobId, uploadUrl, sessionUrl: session.url });
  } catch (err) {
    next(err);
  }
};

export const createAiToolkitSession = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const userEmail = req.user?.email || undefined;
    if (!userId) return res.status(401).json({ error: "Authorization required" });

    const hasAccess = await userHasPaidAiToolkit(userId);
    if (hasAccess) {
      await ensureAiToolkitDashboardNavigationLinkForUser(userId);
      return res.json({
        hasAccess: true,
        redirectUrl: `${process.env.CLIENT_URL}/manager/dashboard`,
      });
    }

    const paymentId = randomUUID();
    await createAiToolkitPayment({
      id: paymentId,
      userId,
      amountCents: AI_TOOLKIT_PRICE_AUD_CENTS,
      currency: CURRENCY,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: userEmail,
      line_items: [
        {
          price_data: {
            currency: CURRENCY,
            unit_amount: AI_TOOLKIT_PRICE_AUD_CENTS,
            product_data: { name: "Sophia AI Business Toolkit" },
          },
          quantity: 1,
        },
      ],
      metadata: {
        product: "sophia-ai-business-toolkit",
        paymentId,
        userId,
      },
      success_url: `${process.env.CLIENT_URL}/ai-toolkit/member-dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/ai-toolkit/dashboard`,
    });

    await markAiToolkitPaymentAwaitingCheckout({
      id: paymentId,
      stripeSessionId: session.id,
      stripeCustomerId: session.customer?.toString() || null,
    });

    return res.json({ paymentId, sessionUrl: session.url });
  } catch (err) {
    next(err);
  }
};

export const getAiToolkitAccess = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authorization required" });

    const hasAccess = await userHasPaidAiToolkit(userId);
    return res.json({ hasAccess });
  } catch (err) {
    next(err);
  }
};

export const confirmAiToolkitSession = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { sessionId } = req.body || {};
    if (!userId) return res.status(401).json({ error: "Authorization required" });
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const payment = await getAiToolkitPaymentBySession(sessionId);
    if (!payment || payment.user_id !== userId) {
      return res.status(404).json({ error: "Payment session not found" });
    }

    if (payment.status === "paid") {
      await ensureAiToolkitDashboardNavigationLinkForUser(userId);
      return res.json({ hasAccess: true, status: "paid" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === "paid") {
      await markAiToolkitPaymentPaidBySession({
        stripeSessionId: session.id,
        stripePaymentIntent: session.payment_intent?.toString() || null,
        stripeCustomerId: session.customer?.toString() || null,
      });
      await ensureAiToolkitDashboardNavigationLinkForUser(userId);
      return res.json({ hasAccess: true, status: "paid" });
    }

    return res.json({ hasAccess: false, status: session.payment_status });
  } catch (err) {
    next(err);
  }
};

export const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    }).webhooks.constructEvent(
      req.body,
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
    const product = session.metadata?.product;
    try {
      if (product === "sophia-ai-business-toolkit") {
        const payment = await markAiToolkitPaymentPaidBySession({
          stripeSessionId: session.id,
          stripePaymentIntent: session.payment_intent?.toString() || null,
          stripeCustomerId: session.customer?.toString() || null,
        });
        if (payment?.user_id) {
          await ensureAiToolkitDashboardNavigationLinkForUser(payment.user_id);
        }
      } else if (jobId) {
        await markJobPaid(jobId, session.payment_intent?.toString() || null);
        // on-demand worker will pick this up (status=paid)
      }
    } catch (e) {
      console.error("Webhook processing error:", e?.message || e);
    }
  }

  res.json({ received: true });
};
