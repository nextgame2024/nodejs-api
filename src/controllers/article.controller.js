import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getAllArticles, getFeedArticles } from "../models/article.model.js";
import { getTagsByArticleIds } from "../models/tag.model.js";
import { getPagination } from "../utils/pagination.js";
import { findArticleBySlug } from "../models/article.model.js";

const DEFAULT_AVATAR = process.env.DEFAULT_AVATAR_URL || "";

export const listArticles = asyncHandler(async (req, res) => {
  const { limit, offset } = getPagination(req);
  const userId = req.user?.id || null;

  const { rows: dbArticles, total } = await getAllArticles({
    userId,
    limit,
    offset,
  });

  const ids = dbArticles.map((a) => a.id);
  const tagMap = await getTagsByArticleIds(ids);

  const articles = dbArticles.map((a) => ({
    id: a.id,
    slug: a.slug,
    title: a.title,
    body: a.body,
    description: a.description,
    favoritesCount: Number(a.favoritesCount) || 0,
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

  res.json({ articles, articlesCount: total });
});

export const getArticle = asyncHandler(async (req, res) => {
  const slug = req.params.slug;
  const userId = req.user?.id || "";

  const row = await findArticleBySlug({ slug, userId });
  if (!row) return res.status(404).json({ error: "Article not found" });

  const tagMap = await getTagsByArticleIds([row.id]);

  const article = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    description: row.description,
    favoritesCount: Number(row.favoritesCount) || 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    favorited: !!row.favorited,
    tagList: tagMap.get(row.id) || [],
    author: {
      image: row.image || DEFAULT_AVATAR,
      bio: row.bio || "",
      username: row.username,
      following: !!row.following,
    },
  };

  res.json({ article });
});
