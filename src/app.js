import express from "express";
import morgan from "morgan";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import articleRoutes from "./routes/article.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import userRoutes from "./routes/user.routes.js";
import tagRoutes from "./routes/tag.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import healthRoutes from "./routes/health.routes.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import diagRoutes from "./routes/diag.routes.js";
import { paymentsRouter, stripeWebhookRoute } from "./routes/payment.routes.js";
import rendersRoutes from "./routes/renders.routes.js";
import teamRoutes from "./routes/team.routes.js";
import employeeRoutes from "./routes/employee.routes.js";

const app = express();

// CORS
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:4200")
  .split(",")
  .map((s) => s.trim());

/* 1) Mount Stripe webhook with RAW body BEFORE express.json() */
app.post(stripeWebhookRoute.path, ...stripeWebhookRoute.handler);

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
app.use("/api", healthRoutes);
app.use("/api", diagRoutes);
app.use("/api", authRoutes);
app.use("/api", articleRoutes);
app.use("/api", profileRoutes);
app.use("/api", userRoutes);
app.use("/api", tagRoutes);
app.use("/api", uploadRoutes);
app.use("/api", paymentsRouter);
app.use("/api", rendersRoutes);
app.use("/api", teamRoutes);
app.use("/api", employeeRoutes);

// Error handler
app.use(errorHandler);

export default app;
