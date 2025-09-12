import { Router } from "express";
import {
  createRenderSession,
  stripeWebhook,
} from "../controllers/payments.controller.js";
import express from "express";

export const paymentsRouter = Router();
// JSON body route
paymentsRouter.post("/renders/create-session", createRenderSession);

// Webhook needs RAW body (mounting helper here is optional;
// we’ll mount it in app.js to ensure it’s BEFORE express.json)
export const stripeWebhookRoute = {
  path: "/api/webhooks/stripe",
  handler: [express.raw({ type: "application/json" }), stripeWebhook],
};
