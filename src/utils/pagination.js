export function getPagination(
  req,
  { defaultLimit = 1000, defaultOffset = 0, maxLimit = 1000 } = {}
) {
  let limit = parseInt(req.query.limit, 10);
  let offset = parseInt(req.query.offset, 10);

  if (Number.isNaN(limit) || limit <= 0) limit = defaultLimit;
  if (Number.isNaN(offset) || offset < 0) offset = defaultOffset;

  if (maxLimit) limit = Math.min(limit, maxLimit);
  return { limit, offset };
}
