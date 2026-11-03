import { Router, raw } from "express";
import { channelProfiles } from "../services/messaging/channel-profiles.js";
import {
  verifySignature,
  verifyToken,
  normalizePayload,
} from "../adapters/whatsapp/inbound.js";
import { receiveEvents } from "../services/messaging/whatsapp-channel.service.js";
// Mounted before global JSON parsing and request logging. No query-token or body
// logging; a 200 is returned only after all accepted events durably commit.
export function createWhatsAppWebhookRouter({
  profiles = channelProfiles,
  receive = receiveEvents,
} = {}) {
  const router = Router();
  const path = "/webhooks/whatsapp/:profileId";
  const resolve = (req) =>
    profiles().find((p) => p.id === req.params.profileId && p.ready);
  router.get(path, (req, res) => {
    try {
      const p = resolve(req);
      if (!p) return res.sendStatus(404);
      const challenge = req.query["hub.challenge"];
      if (
        req.query["hub.mode"] !== "subscribe" ||
        !verifyToken(req.query["hub.verify_token"], p.verifyToken) ||
        typeof challenge !== "string" ||
        !/^\d{1,100}$/.test(challenge)
      )
        return res.sendStatus(403);
      return res.type("text/plain").send(challenge);
    } catch {
      return res.sendStatus(503);
    }
  });
  router.post(
    path,
    raw({ type: "application/json", limit: "256kb" }),
    async (req, res) => {
      try {
        const p = resolve(req);
        if (!p) return res.sendStatus(404);
        if (
          !verifySignature(
            req.body,
            req.headers["x-hub-signature-256"],
            p.appSecret,
          )
        )
          return res.sendStatus(401);
        const events = normalizePayload(req.body, p);
        await receive(p, events);
        return res.sendStatus(200);
      } catch (e) {
        return res.sendStatus(e.status === 400 ? 400 : 503);
      }
    },
  );
  router.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") return res.sendStatus(413);
    return res.sendStatus(400);
  });
  return router;
}
export default createWhatsAppWebhookRouter();
