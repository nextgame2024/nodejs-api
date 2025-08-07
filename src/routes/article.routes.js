import { Router } from "express";
import { listArticles } from "../controllers/article.controller.js";

const router = Router();
router.get("/articles", listArticles);

export default router;
