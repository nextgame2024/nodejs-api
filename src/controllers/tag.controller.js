import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getAllTags } from "../models/tag.model.js";

export const listTags = asyncHandler(async (_req, res) => {
  const tags = await getAllTags();
  res.json({ tags });
});
