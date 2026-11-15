// Bound anonymous form traffic without retaining submitted data or trusting forwarded IP headers.
const buckets = new Map();
export function publicFormRateLimit(req, res, next) {
  const now = Date.now(),
    key =
      (req.ip ?? "unknown") + ":" + (req.method === "POST" ? "write" : "read");
  for (const [id, b] of buckets) if (b.until <= now) buckets.delete(id);
  const b = buckets.get(key) ?? { count: 0, until: now + 60000 };
  if (
    (!buckets.has(key) && buckets.size >= 10000) ||
    ++b.count > (req.method === "POST" ? 10 : 120)
  ) {
    res.set(
      "Retry-After",
      String(Math.max(1, Math.ceil((b.until - now) / 1000))),
    );
    return res
      .status(429)
      .json({
        error: "Too many requests. Please wait a minute and try again.",
      });
  }
  buckets.set(key, b);
  res.set("Cache-Control", "no-store");
  next();
}
