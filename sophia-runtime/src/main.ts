import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { runtimeConfig } from "./config/runtime-config.js";
import { SOPHIA_CORS_ALLOWED_HEADERS, SOPHIA_CORS_EXPOSED_HEADERS } from "./http/cors-policy.js";
import { studentOperationsTimingMiddleware } from "./business-packs/student-operations/student-operations-timing.middleware.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = runtimeConfig();

  app.enableCors({
    origin: config.corsOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [...SOPHIA_CORS_ALLOWED_HEADERS],
    exposedHeaders: [...SOPHIA_CORS_EXPOSED_HEADERS],
  });

  app.use(studentOperationsTimingMiddleware(config.corsOrigins));

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  await app.listen(config.port);
}

void bootstrap();
