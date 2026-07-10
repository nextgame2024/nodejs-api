import { Router } from "express";
import {
  createAiToolkitSession,
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

// Webhook needs RAW body (mounting helper here is optional;
// we’ll mount it in app.js to ensure it’s BEFORE express.json)
export const stripeWebhookRoute = {
  path: "/api/webhooks/stripe",
  handler: [express.raw({ type: "application/json" }), stripeWebhook],
};
