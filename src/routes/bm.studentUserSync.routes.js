import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import { asyncHandler } from "../middlewares/asyncHandler.js";
import {
  syncOverview,
  enqueueSync,
  resolveCandidate,
} from "../services/bm.studentUserSync.service.js";
const router = Router();
router.use("/bm/sync-users", authRequired);
router.get(
  "/bm/sync-users",
  asyncHandler(async (req, res) =>
    res.json(await syncOverview(req.user.id, req.query)),
  ),
);
router.post(
  "/bm/sync-users/runs",
  asyncHandler(async (req, res) =>
    res.status(202).json(await enqueueSync(req.user.id, req.body?.mode)),
  ),
);
router.put(
  "/bm/sync-users/records/:id",
  asyncHandler(async (req, res) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        req.params.id,
      )
    )
      return res.status(400).json({ error: "Invalid record." });
    res.json(
      await resolveCandidate(req.user.id, req.params.id, req.body ?? {}),
    );
  }),
);
export default router;
