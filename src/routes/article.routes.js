import { Router } from "express";
import { listArticles } from "../controllers/article.controller.js";
import { getFeed } from "../controllers/feed.controller.js";
import { authRequired } from "../middlewares/authJwt.js";

const router = Router();
router.get("/articles", listArticles);
router.get("/articles/feed", authRequired, getFeed);
router.get("/articles/:slug", authOptional, getArticle);

export default router;
