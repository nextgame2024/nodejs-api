import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import * as settings from "../services/leads/assistant-settings.service.js";
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
    res
      .status(known ? error.status : 500)
      .json({
        error: known
          ? error.message
          : "Assistant settings could not be loaded or saved. Try again.",
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
export default router;
