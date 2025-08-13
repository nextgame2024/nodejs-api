import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getAllArticles } from "../models/article.model.js";
import { getTagsByArticleIds } from "../models/tag.model.js";
import { getPagination } from "../utils/pagination.js";

const DEFAULT_AVATAR = process.env.DEFAULT_AVATAR_URL || "";

export const listArticles = asyncHandler(async (req, res) => {
  const { limit, offset } = getPagination(req);
  const userId = req.user?.id || null;
  const dbArticles = await getAllArticles({ userId, limit, offset });
  const ids = dbArticles.map((a) => a.id);
  const tagMap = await getTagsByArticleIds(ids);

  const articles = dbArticles.map((a) => ({
    id: a.id,
    slug: a.slug,
    title: a.title,
    body: a.body,
    description: a.description,
    favoritesCount: a.favoritesCount,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    favorited: !!a.favorited,
    tagList: tagMap.get(a.id) || [],
    author: {
      image: a.image || DEFAULT_AVATAR,
      bio: a.bio || "",
      username: a.username,
      following: !!a.following,
    },
  }));

  res.json({ articles, articlesCount: articles.length });
});
