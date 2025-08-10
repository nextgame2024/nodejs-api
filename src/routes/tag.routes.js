import { Router } from "express";
import { listTags } from "../controllers/tag.controller.js";

const router = Router();
router.get("/tags", listTags);

export default router;
