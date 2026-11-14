import * as forms from "../services/leads/lead-forms.service.js";
import { retryVoice } from "../services/messaging/voice-api.service.js";
import {
  responseSettings,
  bindResponse,
  queueReply,
  draftReply,
} from "../services/messaging/reply-api.service.js";
import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import * as settings from "../services/leads/assistant-settings.service.js";
import * as leads from "../services/leads/lead-records.service.js";
import {
  channelStatus,
  configureChannel,
} from "../services/messaging/whatsapp-channel.service.js";
const router = Router();
router.use("/bm/lead-assistant", authRequired);
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    const known =
      (Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status < 500) ||
      error.status === 503;
    res.status(known ? error.status : 500).json({
      error: known
        ? error.message
        : "The assistant request could not be completed. Try again.",
      fields: known ? (error.fields ?? []) : [],
    });
  }
};
router.get(
  "/bm/lead-assistant/settings",
  handle((req) => settings.getSettings(req.user.id, req.user.companyId)),
);
router.get(
  "/bm/lead-assistant/staff",
  handle((req) =>
    settings.searchStaff(req.user.id, req.user.companyId, req.query.q ?? ""),
  ),
);
router.put(
  "/bm/lead-assistant/settings",
  handle((req) =>
    settings.saveSettings(req.user.id, req.user.companyId, req.body),
  ),
);
router.post(
  "/bm/lead-assistant/settings/publish",
  handle((req) =>
    settings.publishSettings(req.user.id, req.user.companyId, req.body),
  ),
);
router.get(
  "/bm/lead-assistant/inbox/context",
  handle((req) => leads.inboxContext(req.user.id, req.user.companyId)),
);
router.get(
  "/bm/lead-assistant/leads",
  handle((req) => leads.listLeads(req.user.id, req.user.companyId, req.query)),
);
router.post(
  "/bm/lead-assistant/leads",
  handle((req) => leads.createLead(req.user.id, req.user.companyId, req.body)),
);
router.get(
  "/bm/lead-assistant/leads/:leadId",
  handle((req) =>
    leads.getLead(req.user.id, req.user.companyId, req.params.leadId),
  ),
);
router.put(
  "/bm/lead-assistant/leads/:leadId",
  handle((req) =>
    leads.updateLead(
      req.user.id,
      req.user.companyId,
      req.params.leadId,
      req.body,
    ),
  ),
);
router.get(
  "/bm/lead-assistant/leads/:leadId/events",
  handle((req) =>
    leads.olderEvents(
      req.user.id,
      req.user.companyId,
      req.params.leadId,
      req.query.before,
    ),
  ),
);
router.post(
  "/bm/lead-assistant/leads/:leadId/notes",
  handle((req) =>
    leads.addNote(req.user.id, req.user.companyId, req.params.leadId, req.body),
  ),
);
router.post(
  "/bm/lead-assistant/leads/:leadId/ownership",
  handle((req) =>
    leads.changeOwnership(
      req.user.id,
      req.user.companyId,
      req.params.leadId,
      req.body,
    ),
  ),
);
router.get(
  "/bm/lead-assistant/channel",
  handle((req) => channelStatus(req.user.id, req.user.companyId)),
);
router.put(
  "/bm/lead-assistant/channel",
  handle((req) => configureChannel(req.user.id, req.user.companyId, req.body)),
);
router.get(
  "/bm/lead-assistant/responses",
  handle((req) => responseSettings(req.user.id, req.user.companyId)),
);
router.put(
  "/bm/lead-assistant/responses",
  handle((req) => bindResponse(req.user.id, req.user.companyId, req.body)),
);
router.post(
  "/bm/lead-assistant/leads/:leadId/replies",
  handle((req) =>
    queueReply(req.user.id, req.user.companyId, req.params.leadId, req.body),
  ),
);
router.post(
  "/bm/lead-assistant/leads/:leadId/draft",
  handle((req) =>
    draftReply(req.user.id, req.user.companyId, req.params.leadId, req.body),
  ),
);
router.post(
  "/bm/lead-assistant/leads/:leadId/voice/:jobId/retry",
  handle((req) =>
    retryVoice(
      req.user.id,
      req.user.companyId,
      req.params.leadId,
      req.params.jobId,
    ),
  ),
);
router.get(
  "/bm/lead-assistant/form-types",
  handle((req) => forms.listTypes(req.user.id, req.user.companyId)),
);
router.post(
  "/bm/lead-assistant/form-types",
  handle((req) => forms.createType(req.user.id, req.user.companyId, req.body)),
);
router.delete(
  "/bm/lead-assistant/form-types/:id",
  handle((req) =>
    forms.deleteType(req.user.id, req.user.companyId, req.params.id),
  ),
);
router.get(
  "/bm/lead-assistant/forms",
  handle((req) => forms.listForms(req.user.id, req.user.companyId, req.query)),
);
router.get(
  "/bm/lead-assistant/forms/:id",
  handle((req) =>
    forms.getForm(req.user.id, req.user.companyId, req.params.id),
  ),
);
router.put(
  "/bm/lead-assistant/forms/:id",
  handle((req) =>
    forms.saveForm(req.user.id, req.user.companyId, req.params.id, req.body),
  ),
);
router.delete(
  "/bm/lead-assistant/forms/:id",
  handle((req) =>
    forms.deleteForm(req.user.id, req.user.companyId, req.params.id, req.body),
  ),
);
export default router;
