import { asyncHandler } from "../middlewares/asyncHandler.js";
import {
  getAllArticles,
  findArticleBySlug,
  findArticleAuthorId,
  deleteArticleBySlug,
  insertArticle,
  updateArticleBySlugForAuthor,
} from "../models/article.model.js";
import { getTagsByArticleIds, setArticleTags } from "../models/tag.model.js";

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

function slugify(title = "") {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${base || "article"}-${rnd}`;
}

export const listArticles = asyncHandler(async (req, res) => {
  const { limit, offset } = parseLimitOffset(req.query);
  const userId = req.user?.id || "";

  const { rows, total } = await getAllArticles({ userId, limit, offset });

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

export const deleteArticle = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { slug } = req.params;

  const authorId = await findArticleAuthorId(slug);
  if (!authorId) return res.status(404).json({ error: "Article not found" });
  if (authorId !== userId) {
    return res
      .status(403)
      .json({ error: "You are not the author of this article" });
  }

  const affected = await deleteArticleBySlug({ slug, userId });
  if (affected === 0) {
    return res.status(404).json({ error: "Article not found" });
  }

  return res.status(204).end();
});

/* CREATE */
export const createArticle = asyncHandler(async (req, res) => {
  const authorId = req.user?.id;
  const payload = req.body?.article || {};
  const { title, description, body } = payload;
  const tagList = Array.isArray(payload.tagList) ? payload.tagList : [];

  const errors = {};
  if (!title || !title.trim()) errors.title = ["can't be blank"];
  if (!description || !description.trim())
    errors.description = ["can't be blank"];
  if (!body || !body.trim()) errors.body = ["can't be blank"];

  if (Object.keys(errors).length) {
    return res.status(422).json({ errors });
  }

  const slug = slugify(title);
  const articleId = await insertArticle({
    authorId,
    slug,
    title,
    description,
    body,
  });

  if (tagList.length) await setArticleTags(articleId, tagList);

  const row = await findArticleBySlug({ slug, userId: authorId });
  const tagMap = await getTagsByArticleIds([articleId]);

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
    tagList: tagMap.get(articleId) || [],
    author: {
      image: row.image || DEFAULT_AVATAR,
      bio: row.bio || "",
      username: row.username,
      following: !!row.following,
    },
  };

  res.status(201).json({ article });
});

/* UPDATE (by slug, only author) */
export const updateArticle = asyncHandler(async (req, res) => {
  const authorId = req.user?.id;
  const slug = req.params.slug;
  const payload = req.body?.article || {};
  const { title, description, body } = payload;
  const tagList = Array.isArray(payload.tagList) ? payload.tagList : undefined;

  const errors = {};
  if (title !== undefined && !String(title).trim())
    errors.title = ["can't be blank"];
  if (description !== undefined && !String(description).trim())
    errors.description = ["can't be blank"];
  if (body !== undefined && !String(body).trim())
    errors.body = ["can't be blank"];
  if (Object.keys(errors).length) {
    return res.status(422).json({ errors });
  }

  const newSlug = title ? slugify(title) : undefined;

  const ok = await updateArticleBySlugForAuthor({
    slug,
    authorId,
    title,
    description,
    body,
    newSlug,
  });
  if (!ok) {
    return res
      .status(404)
      .json({ errors: { article: ["not found or not owned by user"] } });
  }

  if (tagList) {
    const rowAfter = await findArticleBySlug({
      slug: newSlug ?? slug,
      userId: authorId,
    });
    await setArticleTags(rowAfter.id, tagList);
  }

  const row = await findArticleBySlug({
    slug: newSlug ?? slug,
    userId: authorId,
  });
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
