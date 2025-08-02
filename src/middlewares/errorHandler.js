export function errorHandler(err, _req, res, _next) {
  /* eslint-disable no-console */
  console.error(err);
  /* eslint-enable no-console */

  if (res.headersSent) return;
  res
    .status(err.status || 500)
    .json({ error: err.message || "Internal Server Error" });
}
