import { asyncHandler } from "../middlewares/asyncHandler.js";
import * as service from "../services/bm.toolkit.service.js";

function userId(req) {
  return req.user?.id;
}

export const getDashboard = asyncHandler(async (req, res) => {
  res.json(await service.getDashboard(userId(req)));
});

export const listCategories = asyncHandler(async (req, res) => {
  res.json(await service.listCategories(userId(req)));
});

export const getCategory = asyncHandler(async (req, res) => {
  const category = await service.getCategory(userId(req), req.params.slug);
  if (!category) return res.status(404).json({ error: "Category not found" });
  res.json({ category });
});

export const listRecipes = asyncHandler(async (req, res) => {
  res.json(await service.listRecipes(userId(req), req.query));
});

export const getRecipe = asyncHandler(async (req, res) => {
  const recipe = await service.getRecipe(userId(req), req.params.slug);
  if (!recipe) return res.status(404).json({ error: "Recipe not found" });
  res.json({ recipe });
});

export const listQuickActions = asyncHandler(async (req, res) => {
  res.json(await service.listQuickActions(userId(req)));
});

export const listTools = asyncHandler(async (req, res) => {
  res.json(await service.listTools(userId(req)));
});

export const listWorkflows = asyncHandler(async (req, res) => {
  res.json(await service.listWorkflows(userId(req)));
});

export const getStartGuide = asyncHandler(async (req, res) => {
  res.json(await service.getStartGuide(userId(req)));
});

export const getFavorites = asyncHandler(async (req, res) => {
  res.json(await service.getFavorites(userId(req), req.query));
});

export const addFavorite = asyncHandler(async (req, res) => {
  res.status(201).json(await service.addFavorite(userId(req), req.params.recipeSlug));
});

export const removeFavorite = asyncHandler(async (req, res) => {
  res.json(await service.removeFavorite(userId(req), req.params.recipeSlug));
});

export const markRecipeUsed = asyncHandler(async (req, res) => {
  res.status(201).json(await service.markRecipeUsed(userId(req), req.params.recipeSlug));
});
