import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getFeedArticles } from "../models/article.model.js";
import { getTagsByArticleIds } from "../models/tag.model.js";

const DEFAULT_AVATAR = process.env.DEFAULT_AVATAR_URL || "";
const MAX_LIMIT = 1000;

function parseLimitOffset(q) {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(+q.limit) ? +q.limit : MAX_LIMIT)
  );
  const offset = Math.max(0, Number.isFinite(+q.offset) ? +q.offset : 0);
  return { limit, offset };
}

export const getFeed = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { limit, offset } = parseLimitOffset(req.query);
  const { rows, total } = await getFeedArticles({ userId, limit, offset });
  const ids = rows.map((a) => a.id);
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
      following: true, // feed only shows authors you follow
    },
    tagList: tagMap.get(a.id) || [],
  }));

  res.json({ articles, articlesCount: total });
});
