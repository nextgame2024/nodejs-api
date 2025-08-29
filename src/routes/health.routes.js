import { Router } from "express";
import { pingDb } from "../config/db.js";

const router = Router();

router.get("/healthz", async (_req, res) => {
  try {
    await pingDb();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.code || e?.message || String(e),
    });
  }
});

export default router;
