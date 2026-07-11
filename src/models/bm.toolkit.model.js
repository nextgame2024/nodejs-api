import fs from "node:fs/promises";
import path from "node:path";
import pool from "../config/db.js";

let schemaReady = false;
let seedReady = false;

const seedCandidates = [
  process.env.TOOLKIT_SEED_JSON_PATH
    ? path.resolve(process.env.TOOLKIT_SEED_JSON_PATH)
    : null,
  path.resolve(process.cwd(), "../frontend/src/app/ai-toolkit/sophia-ai-business-toolkit-v1.json"),
  path.resolve(process.cwd(), "frontend/src/app/ai-toolkit/sophia-ai-business-toolkit-v1.json"),
].filter(Boolean);

async function readSeedData() {
  for (const filePath of seedCandidates) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      // Try the next likely project cwd.
    }
  }
  return null;
}

export async function ensureToolkitSchema() {
  if (schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS toolkit_metadata (
      product_slug text PRIMARY KEY,
      product_name text NOT NULL,
      version text NOT NULL,
      description text,
      currency text NOT NULL DEFAULT 'AUD',
      price numeric(10, 2) NOT NULL DEFAULT 0,
      last_updated date,
      seeded_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS toolkit_courses (
      slug text PRIMARY KEY,
      title text NOT NULL,
      course_type text NOT NULL,
      level text NOT NULL,
      description text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS toolkit_navigation (
      slug text PRIMARY KEY,
      label text NOT NULL,
      icon text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS toolkit_categories (
      slug text PRIMARY KEY,
      name text NOT NULL,
      description text,
      icon text,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS toolkit_tools (
      slug text PRIMARY KEY,
      name text NOT NULL,
      best_for jsonb NOT NULL DEFAULT '[]'::jsonb,
      difficulty text,
      free_version boolean NOT NULL DEFAULT false,
      description text,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS toolkit_recipes (
      slug text PRIMARY KEY,
      source_id integer,
      title text NOT NULL,
      category_slug text NOT NULL REFERENCES toolkit_categories(slug),
      description text,
      purpose text,
      when_to_use text,
      prompt text NOT NULL,
      before_use jsonb NOT NULL DEFAULT '[]'::jsonb,
      difficulty text,
      time_saved_minutes integer NOT NULL DEFAULT 0,
      best_tool text,
      rating numeric(3, 1) NOT NULL DEFAULT 0,
      is_popular boolean NOT NULL DEFAULT false,
      is_featured boolean NOT NULL DEFAULT false,
      course_type text NOT NULL DEFAULT 'Toolkit',
      level text NOT NULL DEFAULT 'easy',
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS toolkit_recipe_tags (
      recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      tag text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      PRIMARY KEY (recipe_slug, tag)
    );

    CREATE TABLE IF NOT EXISTS toolkit_related_recipes (
      recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      related_recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      sort_order integer NOT NULL DEFAULT 0,
      PRIMARY KEY (recipe_slug, related_recipe_slug)
    );

    CREATE TABLE IF NOT EXISTS toolkit_quick_actions (
      action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label text NOT NULL,
      recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      icon text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      UNIQUE (label, recipe_slug)
    );

    CREATE TABLE IF NOT EXISTS toolkit_workflows (
      slug text PRIMARY KEY,
      title text NOT NULL,
      description text,
      estimated_minutes integer NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS toolkit_workflow_recipes (
      workflow_slug text NOT NULL REFERENCES toolkit_workflows(slug) ON DELETE CASCADE,
      recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      sort_order integer NOT NULL DEFAULT 0,
      PRIMARY KEY (workflow_slug, recipe_slug)
    );

    CREATE TABLE IF NOT EXISTS toolkit_start_guide_sections (
      section_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      heading text NOT NULL,
      body text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS toolkit_favorites (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, recipe_slug)
    );

    CREATE TABLE IF NOT EXISTS toolkit_recipe_usage (
      usage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      used_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS toolkit_course_recipes (
      course_slug text NOT NULL REFERENCES toolkit_courses(slug) ON DELETE CASCADE,
      recipe_slug text NOT NULL REFERENCES toolkit_recipes(slug) ON DELETE CASCADE,
      sort_order integer NOT NULL DEFAULT 0,
      PRIMARY KEY (course_slug, recipe_slug)
    );

    ALTER TABLE toolkit_recipes
      ADD COLUMN IF NOT EXISTS course_type text NOT NULL DEFAULT 'Toolkit',
      ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'easy';

    CREATE INDEX IF NOT EXISTS idx_toolkit_recipes_category
      ON toolkit_recipes(category_slug, sort_order);
    CREATE INDEX IF NOT EXISTS idx_toolkit_recipes_search
      ON toolkit_recipes USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '') || ' ' || COALESCE(prompt, '')));
    CREATE INDEX IF NOT EXISTS idx_toolkit_favorites_user
      ON toolkit_favorites(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_toolkit_usage_user
      ON toolkit_recipe_usage(user_id, used_at DESC);
  `);

  schemaReady = true;
}

export async function ensureToolkitSeeded({ requireSeedData = false } = {}) {
  await ensureToolkitSchema();
  if (seedReady) return;

  const existingSeed = await pool.query(
    "SELECT 1 FROM toolkit_metadata WHERE product_slug = 'sophia-ai-business-toolkit' LIMIT 1",
  );
  if (existingSeed.rowCount > 0) {
    seedReady = true;
    return;
  }

  const data = await readSeedData();
  if (!data) {
    if (requireSeedData) {
      throw new Error(
        "Sophia AI toolkit seed JSON was not found. Set TOOLKIT_SEED_JSON_PATH or run from the monorepo.",
      );
    }
    seedReady = true;
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO toolkit_metadata (
         product_slug, product_name, version, description, currency, price, last_updated, updated_at
       )
       VALUES ('sophia-ai-business-toolkit', $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (product_slug) DO UPDATE SET
         product_name = EXCLUDED.product_name,
         version = EXCLUDED.version,
         description = EXCLUDED.description,
         currency = EXCLUDED.currency,
         price = EXCLUDED.price,
         last_updated = EXCLUDED.last_updated,
         updated_at = now()`,
      [
        data.metadata?.productName,
        data.metadata?.version,
        data.metadata?.description,
        data.metadata?.currency,
        data.metadata?.price,
        data.metadata?.lastUpdated || null,
      ],
    );

    await client.query(
      `INSERT INTO toolkit_courses (
         slug, title, course_type, level, description, active, updated_at
       )
       VALUES (
         'sophia-ai-business-toolkit',
         $1,
         'Toolkit',
         'easy',
         $2,
         true,
         now()
       )
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         course_type = EXCLUDED.course_type,
         level = EXCLUDED.level,
         description = EXCLUDED.description,
         active = true,
         updated_at = now()`,
      [
        data.metadata?.productName || "Sophia AI Business Toolkit",
        data.metadata?.description || null,
      ],
    );

    for (const [index, item] of (data.navigation || []).entries()) {
      const slug = item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await client.query(
        `INSERT INTO toolkit_navigation (slug, label, icon, sort_order, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (slug) DO UPDATE SET
           label = EXCLUDED.label,
           icon = EXCLUDED.icon,
           sort_order = EXCLUDED.sort_order,
           active = true`,
        [slug, item.label, item.icon, index],
      );
    }

    for (const [index, category] of (data.categories || []).entries()) {
      await client.query(
        `INSERT INTO toolkit_categories (slug, name, description, icon, sort_order, active, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, now())
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           icon = EXCLUDED.icon,
           sort_order = EXCLUDED.sort_order,
           active = true,
           updated_at = now()`,
        [category.slug, category.name, category.description, category.icon, index],
      );
    }

    for (const [index, tool] of (data.tools || []).entries()) {
      await client.query(
        `INSERT INTO toolkit_tools (slug, name, best_for, difficulty, free_version, description, sort_order, active)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, true)
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           best_for = EXCLUDED.best_for,
           difficulty = EXCLUDED.difficulty,
           free_version = EXCLUDED.free_version,
           description = EXCLUDED.description,
           sort_order = EXCLUDED.sort_order,
           active = true`,
        [
          tool.slug,
          tool.name,
          JSON.stringify(tool.bestFor || []),
          tool.difficulty,
          Boolean(tool.freeVersion),
          tool.description,
          index,
        ],
      );
    }

    for (const [index, recipe] of (data.recipes || []).entries()) {
      await client.query(
        `INSERT INTO toolkit_recipes (
           slug, source_id, title, category_slug, description, purpose, when_to_use,
           prompt, before_use, difficulty, time_saved_minutes, best_tool, rating,
           is_popular, is_featured, course_type, level, sort_order, active, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, 'Toolkit', 'easy', $16, true, now())
         ON CONFLICT (slug) DO UPDATE SET
           source_id = EXCLUDED.source_id,
           title = EXCLUDED.title,
           category_slug = EXCLUDED.category_slug,
           description = EXCLUDED.description,
           purpose = EXCLUDED.purpose,
           when_to_use = EXCLUDED.when_to_use,
           prompt = EXCLUDED.prompt,
           before_use = EXCLUDED.before_use,
           difficulty = EXCLUDED.difficulty,
           time_saved_minutes = EXCLUDED.time_saved_minutes,
           best_tool = EXCLUDED.best_tool,
           rating = EXCLUDED.rating,
           is_popular = EXCLUDED.is_popular,
           is_featured = EXCLUDED.is_featured,
           course_type = EXCLUDED.course_type,
           level = EXCLUDED.level,
           sort_order = EXCLUDED.sort_order,
           active = true,
           updated_at = now()`,
        [
          recipe.slug,
          recipe.id || index + 1,
          recipe.title,
          recipe.categorySlug,
          recipe.description,
          recipe.purpose,
          recipe.whenToUse,
          recipe.prompt,
          JSON.stringify(recipe.beforeUse || []),
          recipe.difficulty,
          recipe.timeSavedMinutes || 0,
          recipe.bestTool,
          recipe.rating || 0,
          Boolean(recipe.isPopular),
          Boolean(recipe.isFeatured),
          index,
        ],
      );

      await client.query(
        `INSERT INTO toolkit_course_recipes (course_slug, recipe_slug, sort_order)
         VALUES ('sophia-ai-business-toolkit', $1, $2)
         ON CONFLICT (course_slug, recipe_slug) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [recipe.slug, index],
      );

      await client.query("DELETE FROM toolkit_recipe_tags WHERE recipe_slug = $1", [recipe.slug]);
      for (const [tagIndex, tag] of (recipe.tags || []).entries()) {
        await client.query(
          `INSERT INTO toolkit_recipe_tags (recipe_slug, tag, sort_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (recipe_slug, tag) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [recipe.slug, tag, tagIndex],
        );
      }
    }

    for (const recipe of data.recipes || []) {
      await client.query("DELETE FROM toolkit_related_recipes WHERE recipe_slug = $1", [recipe.slug]);
      for (const [relatedIndex, relatedSlug] of (recipe.relatedRecipeSlugs || []).entries()) {
        await client.query(
          `INSERT INTO toolkit_related_recipes (recipe_slug, related_recipe_slug, sort_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (recipe_slug, related_recipe_slug) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [recipe.slug, relatedSlug, relatedIndex],
        );
      }
    }

    for (const [index, action] of (data.quickActions || []).entries()) {
      await client.query(
        `INSERT INTO toolkit_quick_actions (label, recipe_slug, icon, sort_order, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (label, recipe_slug) DO UPDATE SET
           icon = EXCLUDED.icon,
           sort_order = EXCLUDED.sort_order,
           active = true`,
        [action.label, action.recipeSlug, action.icon, index],
      );
    }

    for (const [index, workflow] of (data.workflows || []).entries()) {
      await client.query(
        `INSERT INTO toolkit_workflows (slug, title, description, estimated_minutes, sort_order, active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           estimated_minutes = EXCLUDED.estimated_minutes,
           sort_order = EXCLUDED.sort_order,
           active = true`,
        [workflow.slug, workflow.title, workflow.description, workflow.estimatedMinutes || 0, index],
      );
      await client.query("DELETE FROM toolkit_workflow_recipes WHERE workflow_slug = $1", [workflow.slug]);
      for (const [recipeIndex, recipeSlug] of (workflow.recipeSlugs || []).entries()) {
        await client.query(
          `INSERT INTO toolkit_workflow_recipes (workflow_slug, recipe_slug, sort_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (workflow_slug, recipe_slug) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [workflow.slug, recipeSlug, recipeIndex],
        );
      }
    }

    await client.query("DELETE FROM toolkit_start_guide_sections");
    for (const [index, section] of (data.startHereGuide?.sections || []).entries()) {
      await client.query(
        `INSERT INTO toolkit_start_guide_sections (title, heading, body, sort_order, active)
         VALUES ($1, $2, $3, $4, true)`,
        [data.startHereGuide?.title || "Start Here Guide", section.heading, section.body, index],
      );
    }

    await client.query("COMMIT");
    seedReady = true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const RECIPE_SELECT = `
  r.slug,
  r.source_id AS "sourceId",
  r.title,
  c.name AS "category",
  r.category_slug AS "categorySlug",
  r.description,
  r.purpose,
  r.when_to_use AS "whenToUse",
  r.prompt,
  r.before_use AS "beforeUse",
  r.difficulty,
  r.time_saved_minutes AS "timeSavedMinutes",
  r.best_tool AS "bestTool",
  r.rating::float AS rating,
  r.is_popular AS "isPopular",
  r.is_featured AS "isFeatured",
  r.course_type AS "courseType",
  r.level,
  EXISTS (
    SELECT 1 FROM toolkit_favorites f
    WHERE f.user_id = $1 AND f.recipe_slug = r.slug
  ) AS "isFavorite",
  COALESCE((
    SELECT jsonb_agg(t.tag ORDER BY t.sort_order)
    FROM toolkit_recipe_tags t
    WHERE t.recipe_slug = r.slug
  ), '[]'::jsonb) AS tags
`;

export async function getDashboard(userId) {
  await ensureToolkitSchema();
  const [categories, quickActions, featured, popular, progress] = await Promise.all([
    listCategories(userId),
    listQuickActions(userId),
    listRecipes(userId, { featured: true, limit: 3 }),
    listRecipes(userId, { popular: true, limit: 6 }),
    getProgress(userId),
  ]);
  return { categories, quickActions, featuredRecipes: featured.recipes, popularRecipes: popular.recipes, progress };
}

export async function listCategories() {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT
       c.slug,
       c.name,
       c.description,
       c.icon,
       COUNT(r.slug)::int AS "recipeCount"
     FROM toolkit_categories c
     LEFT JOIN toolkit_recipes r ON r.category_slug = c.slug AND r.active = true
     WHERE c.active = true
     GROUP BY c.slug, c.name, c.description, c.icon, c.sort_order
     ORDER BY c.sort_order ASC`,
  );
  return rows;
}

export async function getCategory(userId, slug) {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT slug, name, description, icon
     FROM toolkit_categories
     WHERE slug = $1 AND active = true
     LIMIT 1`,
    [slug],
  );
  if (!rows[0]) return null;
  const recipes = await listRecipes(userId, { categorySlug: slug, limit: 100 });
  return { ...rows[0], recipes: recipes.recipes };
}

export async function listRecipes(userId, filters = {}) {
  await ensureToolkitSchema();
  const params = [userId];
  const where = ["r.active = true"];
  let i = 2;

  if (filters.categorySlug) {
    where.push(`r.category_slug = $${i++}`);
    params.push(filters.categorySlug);
  }
  if (filters.q) {
    where.push(`(r.title ILIKE $${i} OR r.description ILIKE $${i} OR r.prompt ILIKE $${i})`);
    params.push(`%${filters.q}%`);
    i++;
  }
  if (filters.popular) where.push("r.is_popular = true");
  if (filters.featured) where.push("r.is_featured = true");
  if (filters.favorite) {
    where.push(`EXISTS (SELECT 1 FROM toolkit_favorites f WHERE f.user_id = $1 AND f.recipe_slug = r.slug)`);
  }

  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 100));
  const offset = Math.max(0, Number(filters.offset) || 0);
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT ${RECIPE_SELECT}
     FROM toolkit_recipes r
     JOIN toolkit_categories c ON c.slug = r.category_slug
     WHERE ${where.join(" AND ")}
     ORDER BY r.sort_order ASC
     LIMIT $${i++} OFFSET $${i}`,
    params,
  );

  const countParams = params.slice(0, -2);
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM toolkit_recipes r
     WHERE ${where.join(" AND ")}
       AND $1::uuid IS NOT NULL`,
    countParams,
  );

  return { recipes: rows, total: countRows[0]?.total || 0, limit, offset };
}

export async function getRecipe(userId, slug) {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT ${RECIPE_SELECT}
     FROM toolkit_recipes r
     JOIN toolkit_categories c ON c.slug = r.category_slug
     WHERE r.slug = $2 AND r.active = true
     LIMIT 1`,
    [userId, slug],
  );
  const recipe = rows[0];
  if (!recipe) return null;

  const { rows: related } = await pool.query(
    `SELECT rel.related_recipe_slug AS slug, rr.title
     FROM toolkit_related_recipes rel
     JOIN toolkit_recipes rr ON rr.slug = rel.related_recipe_slug
     WHERE rel.recipe_slug = $1 AND rr.active = true
     ORDER BY rel.sort_order ASC`,
    [slug],
  );

  return { ...recipe, relatedRecipes: related };
}

export async function listQuickActions(userId) {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT
       qa.label,
       qa.icon,
       qa.recipe_slug AS "recipeSlug",
       r.title AS "recipeTitle",
       r.description AS "recipeDescription",
       EXISTS (
         SELECT 1 FROM toolkit_favorites f
         WHERE f.user_id = $1 AND f.recipe_slug = qa.recipe_slug
       ) AS "isFavorite"
     FROM toolkit_quick_actions qa
     JOIN toolkit_recipes r ON r.slug = qa.recipe_slug
     WHERE qa.active = true AND r.active = true
     ORDER BY qa.sort_order ASC`,
    [userId],
  );
  return rows;
}

export async function listTools() {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT slug, name, best_for AS "bestFor", difficulty, free_version AS "freeVersion", description
     FROM toolkit_tools
     WHERE active = true
     ORDER BY sort_order ASC`,
  );
  return rows;
}

export async function listWorkflows() {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT
       w.slug,
       w.title,
       w.description,
       w.estimated_minutes AS "estimatedMinutes",
       COALESCE(jsonb_agg(jsonb_build_object('slug', r.slug, 'title', r.title) ORDER BY wr.sort_order) FILTER (WHERE r.slug IS NOT NULL), '[]'::jsonb) AS recipes
     FROM toolkit_workflows w
     LEFT JOIN toolkit_workflow_recipes wr ON wr.workflow_slug = w.slug
     LEFT JOIN toolkit_recipes r ON r.slug = wr.recipe_slug
     WHERE w.active = true
     GROUP BY w.slug, w.title, w.description, w.estimated_minutes, w.sort_order
     ORDER BY w.sort_order ASC`,
  );
  return rows;
}

export async function getStartGuide() {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT title, heading, body, sort_order AS "sortOrder"
     FROM toolkit_start_guide_sections
     WHERE active = true
     ORDER BY sort_order ASC`,
  );
  return { title: rows[0]?.title || "Start Here Guide", sections: rows };
}

export async function getProgress(userId) {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(DISTINCT recipe_slug)::int FROM toolkit_recipe_usage WHERE user_id = $1) AS "recipesUsed",
       (SELECT COUNT(*)::int FROM toolkit_favorites WHERE user_id = $1) AS "favoriteRecipes",
       COALESCE((
         SELECT SUM(r.time_saved_minutes)::int
         FROM (
           SELECT DISTINCT recipe_slug FROM toolkit_recipe_usage WHERE user_id = $1
         ) u
         JOIN toolkit_recipes r ON r.slug = u.recipe_slug
       ), 0) AS "timeSavedMinutes"`,
    [userId],
  );
  return rows[0] || { recipesUsed: 0, favoriteRecipes: 0, timeSavedMinutes: 0 };
}

export async function addFavorite(userId, recipeSlug) {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `INSERT INTO toolkit_favorites (user_id, recipe_slug)
     VALUES ($1, $2)
     ON CONFLICT (user_id, recipe_slug) DO NOTHING
     RETURNING recipe_slug AS "recipeSlug"`,
    [userId, recipeSlug],
  );
  return rows[0] || { recipeSlug };
}

export async function removeFavorite(userId, recipeSlug) {
  await ensureToolkitSchema();
  await pool.query(
    `DELETE FROM toolkit_favorites WHERE user_id = $1 AND recipe_slug = $2`,
    [userId, recipeSlug],
  );
  return { recipeSlug };
}

export async function markRecipeUsed(userId, recipeSlug) {
  await ensureToolkitSchema();
  const { rows } = await pool.query(
    `INSERT INTO toolkit_recipe_usage (user_id, recipe_slug)
     VALUES ($1, $2)
     RETURNING usage_id AS "usageId", recipe_slug AS "recipeSlug", used_at AS "usedAt"`,
    [userId, recipeSlug],
  );
  return rows[0];
}
