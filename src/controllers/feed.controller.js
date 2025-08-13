import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getFeedArticles } from "../models/article.model.js";
import { getTagsByArticleIds } from "../models/tag.model.js";
import { getPagination } from "../utils/pagination.js";

const DEFAULT_AVATAR = process.env.DEFAULT_AVATAR_URL || "";

export const getFeed = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { limit, offset } = getPagination(req);

  const { rows, total } = await getFeedArticles({ userId, limit, offset });

  const ids = rows.map((r) => r.id);
  const tagMap = await getTagsByArticleIds(ids);

  const articles = rows.map((a) => ({
    id: a.id,
    slug: a.slug,
    title: a.title,
    body: a.body,
    description: a.description,
    favoritesCount: Number(a.favoritesCount) || 0,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    favorited: !!a.favorited,
    author: {
      image: a.image || DEFAULT_AVATAR,
      bio: a.bio || "",
      username: a.username,
      following: true,
    },
    tagList: tagMap.get(a.id) || [],
  }));

  res.json({ articles, articlesCount: total });
});
