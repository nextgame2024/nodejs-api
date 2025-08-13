import { asyncHandler } from "../middlewares/asyncHandler.js";
import { getAllTags } from "../models/tag.model.js";
import { getPagination } from "../utils/pagination.js";

export const listTags = asyncHandler(async (req, res) => {
  const { limit, offset } = getPagination(req);
  const tags = await getAllTags({ limit, offset });
  res.json({ tags });
});
