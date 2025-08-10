import express from "express";
import morgan from "morgan";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import articleRoutes from "./routes/article.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import userRoutes from "./routes/user.routes.js";
import tagRoutes from "./routes/tag.routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";

const app = express();

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:4200")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin(origin, cb) {
      // allow non-browser tools (no Origin header) and allowed origins
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    optionsSuccessStatus: 204,
  })
);
app.options(/.*/, cors());

// Global middleware
app.use(express.json());
app.use(morgan("dev"));

// Routes
app.use("/api", authRoutes);
app.use("/api", articleRoutes);
app.use("/api", profileRoutes);
app.use("/api", userRoutes);
app.use("/api", tagRoutes);

// Error handler
app.use(errorHandler);

export default app;
