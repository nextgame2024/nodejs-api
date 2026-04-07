import { Router } from "express";
import {
  listArticles,
  getArticle,
  listArticleAssets,
  deleteArticle,
  favoriteArticle,
  unfavoriteArticle,
} from "../controllers/article.controller.js";
import { authRequired } from "../middlewares/authJwt.js";
import { authOptional } from "../middlewares/authOptional.js";

const router = Router();
router.get("/articles", authOptional, listArticles);
router.get("/articles/:slug", authOptional, getArticle);
router.delete("/articles/:slug", authRequired, deleteArticle);
router.post("/articles/:slug/favorite", authRequired, favoriteArticle);
router.delete("/articles/:slug/favorite", authRequired, unfavoriteArticle);
router.get("/articles/:slug/assets", authOptional, listArticleAssets);

export default router;
