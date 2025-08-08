import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getFeedArticles } from "../models/article.model.js";

export const getFeed = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const limit = req.query.limit || 20;
  const offset = req.query.offset || 0;

  const rows = await getFeedArticles({ userId, limit, offset });

  const articles = rows.map((a) => ({
    id: a.id,
    slug: a.slug,
    title: a.title,
    body: a.body,
    description: a.description,
    favoritesCount: Number(a.favoritesCount) || 0,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    favorited: !!a.favorited, // boolean
    author: {
      image: a.image || "",
      bio: a.bio || "",
      username: a.username,
      following: true, // by definition, feed authors are followed
    },
    tagList: [], // implement tags later
  }));

  res.json({ articles, articlesCount: articles.length });
});
