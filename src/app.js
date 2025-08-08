import express from "express";
import morgan from "morgan";
import authRoutes from "./routes/auth.routes.js";
import articleRoutes from "./routes/article.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";

const app = express();

// Global middleware
app.use(express.json());
app.use(morgan("dev"));

// Routes
app.use("/api/v1/auth", authRoutes);
app.use("/api", articleRoutes);
app.use("/api", profileRoutes);

// Error handler
app.use(errorHandler);

export default app;
