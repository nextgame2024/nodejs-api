import { Router } from "express";
import { getRenderStatus } from "../controllers/renders.controller.js";

const router = Router();
router.get("/renders/:id", getRenderStatus);

export default router;
