import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module.js";
import { KnowledgeFileIntakeService } from "../src/admin/knowledge/files/knowledge-file-intake.service.js";

const tenantId = process.env.SOPHIA_KNOWLEDGE_WORKER_TENANT_ID;
if (!tenantId) throw new Error("SOPHIA_KNOWLEDGE_WORKER_TENANT_ID is required; the worker is intentionally tenant-scoped for RLS.");
const once = process.argv.includes("--once");
const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
const worker = app.get(KnowledgeFileIntakeService);
let stopping = false;
process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

try {
  do {
    const result = await worker.runOnce(tenantId, 5);
    console.log(JSON.stringify({ tenantId, ...result }));
    if (!once && !stopping && result.claimed === 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
  } while (!once && !stopping);
} finally {
  await app.close();
}
