import { Router } from "express";
import { authRequired } from "../middlewares/authJwt.js";
import {
  addFavorite,
  getCategory,
  getDashboard,
  getFavorites,
  getRecipe,
  getStartGuide,
  listCategories,
  listQuickActions,
  listRecipes,
  listTools,
  listWorkflows,
  markRecipeUsed,
  removeFavorite,
} from "../controllers/bm.toolkit.controller.js";

const router = Router();

router.get("/bm/toolkit/dashboard", authRequired, getDashboard);
router.get("/bm/toolkit/categories", authRequired, listCategories);
router.get("/bm/toolkit/categories/:slug", authRequired, getCategory);
router.get("/bm/toolkit/recipes", authRequired, listRecipes);
router.get("/bm/toolkit/recipes/:slug", authRequired, getRecipe);
router.post("/bm/toolkit/recipes/:recipeSlug/use", authRequired, markRecipeUsed);
router.get("/bm/toolkit/quick-actions", authRequired, listQuickActions);
router.get("/bm/toolkit/favorites", authRequired, getFavorites);
router.post("/bm/toolkit/favorites/:recipeSlug", authRequired, addFavorite);
router.delete("/bm/toolkit/favorites/:recipeSlug", authRequired, removeFavorite);
router.get("/bm/toolkit/tools", authRequired, listTools);
router.get("/bm/toolkit/workflows", authRequired, listWorkflows);
router.get("/bm/toolkit/start-guide", authRequired, getStartGuide);

export default router;
