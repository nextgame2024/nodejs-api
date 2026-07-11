import { userHasPaidAiToolkit } from "../models/aiToolkitPayment.model.js";
import * as modelNS from "../models/bm.toolkit.model.js";

const model = modelNS.default ?? modelNS;

async function assertToolkitAccess(userId) {
  const hasAccess = await userHasPaidAiToolkit(userId);
  if (!hasAccess) {
    const err = new Error("AI Toolkit access is required");
    err.status = 403;
    throw err;
  }
}

function pageArgs(query = {}) {
  const limit = Math.max(1, Math.min(Number(query.limit) || 50, 100));
  const page = Math.max(1, Number(query.page) || 1);
  return { limit, offset: (page - 1) * limit, page };
}

export async function getDashboard(userId) {
  await assertToolkitAccess(userId);
  return model.getDashboard(userId);
}

export async function listCategories(userId) {
  await assertToolkitAccess(userId);
  return { categories: await model.listCategories(userId) };
}

export async function getCategory(userId, slug) {
  await assertToolkitAccess(userId);
  return model.getCategory(userId, slug);
}

export async function listRecipes(userId, query = {}) {
  await assertToolkitAccess(userId);
  const { limit, offset, page } = pageArgs(query);
  const result = await model.listRecipes(userId, {
    q: query.q,
    categorySlug: query.categorySlug,
    favorite: query.favorite === "true" || query.favorite === true,
    popular: query.popular === "true" || query.popular === true,
    featured: query.featured === "true" || query.featured === true,
    limit,
    offset,
  });
  return { ...result, page };
}

export async function getRecipe(userId, slug) {
  await assertToolkitAccess(userId);
  return model.getRecipe(userId, slug);
}

export async function listQuickActions(userId) {
  await assertToolkitAccess(userId);
  return { quickActions: await model.listQuickActions(userId) };
}

export async function listTools(userId) {
  await assertToolkitAccess(userId);
  return { tools: await model.listTools() };
}

export async function listWorkflows(userId) {
  await assertToolkitAccess(userId);
  return { workflows: await model.listWorkflows() };
}

export async function getStartGuide(userId) {
  await assertToolkitAccess(userId);
  return model.getStartGuide();
}

export async function getFavorites(userId, query = {}) {
  return listRecipes(userId, { ...query, favorite: true });
}

export async function addFavorite(userId, recipeSlug) {
  await assertToolkitAccess(userId);
  return { favorite: await model.addFavorite(userId, recipeSlug) };
}

export async function removeFavorite(userId, recipeSlug) {
  await assertToolkitAccess(userId);
  return { favorite: await model.removeFavorite(userId, recipeSlug) };
}

export async function markRecipeUsed(userId, recipeSlug) {
  await assertToolkitAccess(userId);
  return { usage: await model.markRecipeUsed(userId, recipeSlug) };
}
