import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(backendRoot, "..");

const scopes = [
  {
    id: "active-runtime-student-quarantine",
    files: [
      path.join(backendRoot, "sophia-runtime/src/tools/tools.module.ts"),
      path.join(backendRoot, "sophia-runtime/src/tools/tools.service.ts"),
      path.join(backendRoot, "sophia-runtime/src/business-packs/real-estate/business-manager.client.ts"),
      path.join(backendRoot, "sophia-runtime/src/knowledge/sophia-profile.ts"),
      path.join(workspaceRoot, "frontend/src/app/sophia-runtime/kiosk/sophia-kiosk.page.ts"),
    ],
    forbid: [
      /(?:from|import\s*\()[^\n]*student[-_/ ]?(?:agency|migration|consultation)?/i,
      /\/bm\/student-agency\//i,
      /\b(?:createStudentAgencyTools|createStudentConsultationTools|STUDENT_CONSULTATION_TOOL_NAMES)\b/,
    ],
  },
  {
    id: "runtime-generic-tool-core",
    files: [
      path.join(backendRoot, "sophia-runtime/src/tools/tools.service.ts"),
      path.join(backendRoot, "sophia-runtime/src/tools/tool-registry.ts"),
      path.join(backendRoot, "sophia-runtime/src/tools/action-review.store.ts"),
      path.join(backendRoot, "sophia-runtime/src/knowledge/sophia-profile.ts"),
    ],
    forbid: [
      /\b(?:real[-_ ]?estate|property|inspection|listing|suburb|bedrooms|sale booking|rental)\b/i,
      /(?:from|import\s*\()[^\n]*(?:business-packs\/real-estate|compatibility\/v1\/real-estate)/i,
      /student[-_ ]?(?:agency|migration|consultation)/i,
    ],
  },
  {
    id: "runtime-core-v2",
    root: path.join(backendRoot, "sophia-runtime/src/platform"),
    forbid: [
      /(?:from|require\s*\()[^\n]*(?:openai|anthropic|claude|gemini|google-genai|tavus|simli|liveavatar)/i,
      /(?:from|require\s*\()[^\n]*business-packs\/real-estate/i,
      /\b(?:openai|anthropic|claude|gemini|tavus|simli|liveavatar)\b\s*[:=]/i,
      /student[-_ ]?(?:agency|migration|consultation)/i,
    ],
  },
  {
    id: "portability-neutral-fixture",
    files: [
      path.join(backendRoot, "sophia-runtime/test/portability/synthetic-capability-laboratory.fixture.ts"),
    ],
    forbid: [
      /(?:from|require\s*\()[^\n]*(?:business-packs\/real-estate|student[-_/ ]?(?:agency|migration|consultation)?)/i,
      /(?:from|require\s*\()[^\n]*(?:openai|anthropic|claude|gemini|google-genai|tavus|simli|liveavatar)/i,
    ],
  },
  {
    id: "runtime-v1-compatibility",
    root: path.join(backendRoot, "sophia-runtime/src/compatibility"),
    forbid: [
      /(?:from|require\s*\()[^\n]*(?:openai|anthropic|claude|gemini|google-genai|tavus|simli|liveavatar)/i,
      /student[-_ ]?(?:agency|migration|consultation)/i,
    ],
  },
  {
    id: "runtime-sophia-admin",
    root: path.join(backendRoot, "sophia-runtime/src/admin"),
    forbid: [
      /(?:from|require\s*\()[^\n]*(?:openai|anthropic|claude|gemini|google-genai|tavus|simli|liveavatar)/i,
      /student[-_ ]?(?:agency|migration|consultation)/i,
      /c2dad143-077c-4082-92f0-47805601db3b/i,
    ],
  },
  {
    id: "runtime-connectors-v2",
    root: path.join(backendRoot, "sophia-runtime/src/connectors"),
    forbid: [
      /(?:from|require\s*\()[^\n]*(?:openai|anthropic|claude|gemini|google-genai|tavus|simli|liveavatar)/i,
      /student[-_ ]?(?:agency|migration|consultation)/i,
    ],
  },
  {
    id: "runtime-capabilities-v2",
    root: path.join(backendRoot, "sophia-runtime/src/capabilities-v2"),
    forbid: [
      /(?:from|require\s*\()[^\n]*(?:openai|anthropic|claude|gemini|google-genai|tavus|simli|liveavatar)/i,
      /\b(?:real[-_ ]?estate|propertyId|listingId|suburb|bedrooms|industry(?:Type|Key|Enum)?|student[-_ ]?(?:agency|migration|consultation))\b/i,
    ],
  },
  {
    id: "runtime-business-packs-v2",
    root: path.join(backendRoot, "sophia-runtime/src/business-packs"),
    forbid: [
      /(?:from|require\s*\()[^\n]*(?:openai|anthropic|claude|gemini|google-genai|tavus|simli|liveavatar)/i,
      /student[-_ ]?(?:agency|migration|consultation)/i,
    ],
  },
  {
    id: "business-api-sophia-v2",
    root: path.join(backendRoot, "src/sophia-v2"),
    forbid: [/student[-_ ]?(?:agency|migration|consultation)/i],
  },
  {
    id: "frontend-sophia-core",
    root: path.join(workspaceRoot, "frontend/src/app/sophia-core"),
    forbid: [
      /(?:from|import\s*\()[^\n]*(?:openai|anthropic|claude|gemini|tavus|simli|liveavatar)/i,
      /student[-_ ]?(?:agency|migration|consultation)/i,
    ],
  },
  {
    id: "frontend-sophia-admin",
    root: path.join(workspaceRoot, "frontend/src/app/sophia-admin"),
    forbid: [/student[-_ ]?(?:agency|migration|consultation)/i],
  },
];

async function sourceFiles(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return /\.(?:c|m)?(?:j|t)sx?$/.test(entry.name) ? [target] : [];
    }));
    return nested.flat();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function auditSophiaBoundaries() {
  const violations = [];
  let filesScanned = 0;
  for (const scope of scopes) {
    const files = scope.files || await sourceFiles(scope.root);
    for (const file of files) {
      filesScanned += 1;
      const source = await fs.readFile(file, "utf8");
      for (const rule of scope.forbid) {
        if (rule.test(source)) {
          violations.push({
            scope: scope.id,
            file: path.relative(workspaceRoot, file),
            rule: String(rule),
          });
        }
      }
    }
  }
  return { filesScanned, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditSophiaBoundaries();
  if (result.violations.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      `Sophia v2 boundary check passed (${result.filesScanned} new-product source files scanned).`,
    );
  }
}
