import { captureSync } from "../services/messaging/whatsapp-coexistence.service.js";
import { Router, raw } from "express";
import { workerProfiles } from "../services/messaging/channel-profiles.js";
import {
  verifySignature,
  verifyToken,
  normalizePayload,
} from "../adapters/whatsapp/inbound.js";
import { receiveEvents } from "../services/messaging/whatsapp-channel.service.js";
// Mounted before global JSON parsing and request logging. No query-token or body
// logging; a 200 is returned only after all accepted events durably commit.
export function createWhatsAppWebhookRouter({
  profiles = workerProfiles,
  receive = receiveEvents,
  capture = captureSync,
} = {}) {
  const router = Router();
  const path = "/webhooks/whatsapp/:profileId";
  const resolve = async (req) =>
    (await profiles()).find((p) => p.id === req.params.profileId && p.ready);
  router.get(path, async (req, res) => {
    try {
      const p = await resolve(req);
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
    raw({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
      try {
        const p = await resolve(req);
        if (!p) return res.sendStatus(404);
        if (
          !verifySignature(
            req.body,
            req.headers["x-hub-signature-256"],
            p.appSecret,
          )
        )
          return res.sendStatus(401);
        let payload;
        try {
          payload = JSON.parse(req.body.toString("utf8"));
        } catch {
          return res.sendStatus(400);
        }
        if (
          payload?.object !== "whatsapp_business_account" ||
          !Array.isArray(payload.entry) ||
          payload.entry.length > 100
        )
          return res.sendStatus(400);
        const candidates = (await profiles()).filter(
          (candidate) => candidate.appSecret === p.appSecret,
        );
        let matched = false;
        for (const candidate of candidates) {
          const entries = [];
          const sync = [];
          for (const entry of payload.entry) {
            if (!Array.isArray(entry.changes) || entry.changes.length > 100)
              return res.sendStatus(400);
            const changes = [];
            for (const change of entry.changes) {
              const account =
                change.field === "account_update"
                  ? (change.value?.waba_info?.waba_id ?? entry.id)
                  : entry.id;
              if (account !== candidate.businessAccountId) continue;
              if (
                [
                  "messages",
                  "smb_message_echoes",
                  "history",
                  "smb_app_state_sync",
                ].includes(change.field) &&
                change.value?.metadata?.phone_number_id !==
                  candidate.phoneNumberId
              )
                continue;
              matched = true;
              if (
                candidate.coexistence &&
                ["history", "smb_app_state_sync", "account_update"].includes(
                  change.field,
                )
              )
                sync.push(change);
              else changes.push(change);
            }
            if (changes.length) entries.push({ ...entry, changes });
          }
          if (sync.length) await capture(candidate, sync);
          if (entries.length) {
            const events = normalizePayload(
              Buffer.from(JSON.stringify({ ...payload, entry: entries })),
              candidate,
            );
            await receive(candidate, events);
          }
        }
        return res.sendStatus(matched ? 200 : 400);
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
