import jwt from "jsonwebtoken";

export function authOptional(req, _res, next) {
  const auth = req.get("Authorization") || "";
  const [scheme, token] = auth.split(" ");
  if (!token || !/^(Token|Bearer)$/i.test(scheme)) return next();

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload.sub || payload; // keep whatever you set in authRequired
  } catch {
    // ignore invalid token and continue as anonymous
  }
  next();
}
