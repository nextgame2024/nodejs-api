import { Router } from "express";
import {
  createAiToolkitSession,
  confirmAiToolkitSession,
  getAiToolkitAccess,
  createRenderSession,
  stripeWebhook,
} from "../controllers/payments.controller.js";
import express from "express";
import { authRequired } from "../middlewares/authJwt.js";

export const paymentsRouter = Router();
// JSON body route
paymentsRouter.post("/renders/create-session", createRenderSession);
paymentsRouter.post(
  "/ai-toolkit/create-checkout-session",
  authRequired,
  createAiToolkitSession
);
paymentsRouter.get("/ai-toolkit/access", authRequired, getAiToolkitAccess);
paymentsRouter.post(
  "/ai-toolkit/confirm-session",
  authRequired,
  confirmAiToolkitSession
);

// Webhook needs RAW body (mounting helper here is optional;
// we’ll mount it in app.js to ensure it’s BEFORE express.json)
export const stripeWebhookRoute = {
  path: "/api/webhooks/stripe",
  handler: [express.raw({ type: "application/json" }), stripeWebhook],
};
