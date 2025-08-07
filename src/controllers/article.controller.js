import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getAllArticles } from "../models/article.model.js";

export const listArticles = asyncHandler(async (_req, res) => {
  const dbArticles = await getAllArticles();

  const articles = dbArticles.map((a) => ({
    id: a.id,
    slug: a.slug,
    title: a.title,
    body: a.body,
    description: a.description,
    favoritesCount: a.favoritesCount,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    favorited: false, // implement favorites later
    tagList: [], // implement tags later
    author: {
      image: a.image || "",
      bio: a.bio || "",
      username: a.username,
      following: false, // implement follows later
    },
  }));

  res.json({ articles, articlesCount: articles.length });
});
