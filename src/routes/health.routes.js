import { Router } from "express";
import { pingDb } from "../config/db.js";

const router = Router();

router.get("/healthz", async (_req, res) => {
  try {
    await pingDb();
    res.json({ ok: true, revision: process.env.RENDER_GIT_COMMIT?.slice(0, 12) || null });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.code || e?.message || String(e),
    });
  }
});

export default router;
