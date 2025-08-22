import { Router } from "express";
import {
  listArticles,
  getArticle,
  deleteArticle,
} from "../controllers/article.controller.js";
import { getFeed } from "../controllers/feed.controller.js";
import { authRequired } from "../middlewares/authJwt.js";
import { authOptional } from "../middlewares/authOptional.js";

const router = Router();
router.get("/articles", authOptional, listArticles);
router.get("/articles/feed", authRequired, getFeed);
router.get("/articles/:slug", authOptional, getArticle);
router.delete("/articles/:slug", authRequired, deleteArticle);
router.post("/articles", authRequired, createArticle);
router.put("/articles/:slug", authRequired, updateArticle);

export default router;
