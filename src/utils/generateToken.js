import jwt from "jsonwebtoken";
import { config } from "../config/index.js";

export function generateToken(payload) {
  return jwt.sign({ sub: payload }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}
