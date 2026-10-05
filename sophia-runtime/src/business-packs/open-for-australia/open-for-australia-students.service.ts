import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { DatabaseService } from "../../database/database.service.js";
import {
  projectOpenForAustraliaFields,
  type OpenForAustraliaField,
} from "./open-for-australia-policy.js";
import type { OpenForAustraliaWorkspacePrincipal } from "./open-for-australia-workspace.service.js";

const StudentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "action_required", "on_hold", "completed", "archived"]).optional(),
  advisor: z.enum(["assigned", "unassigned", "me"]).optional(),
  advisorIdentityUserId: z.string().trim().min(1).max(200).optional(),
  college: z.string().trim().min(1).max(160).optional(),
}).strict();

type StudentListRow = {
  student_id: string;
  student_reference: string;
  legal_name: string;
  preferred_name: string | null;
  email: string;
  current_stage: string;
  status: string;
  college_name: string | null;
  advisor_identity_user_id: string | null;
  total_count: number;
};

@Injectable()
export class OpenForAustraliaStudentsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(principal: OpenForAustraliaWorkspacePrincipal, input: unknown) {
    const parsed = StudentListQuerySchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid student list query.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."), message: issue.message,
        })),
      });
    }
    const value = parsed.data;
    const schema = runtimeSchema();
    return this.database.tenantReadTransaction(principal.tenantId, async (client) => {
      const clauses = ["customer_id = $1"];
      const params: unknown[] = [principal.tenantId];
      const add = (clause: string, parameter: unknown) => {
        params.push(parameter);
        clauses.push(clause.replace("?", `$${params.length}`));
      };
      if (principal.role === "advisor") {
        add("advisor_identity_user_id = ?", principal.identityUserId);
      } else if (value.advisorIdentityUserId) {
        add("advisor_identity_user_id = ?", value.advisorIdentityUserId);
      } else if (value.advisor === "me") {
        add("advisor_identity_user_id = ?", principal.identityUserId);
      } else if (value.advisor === "assigned") {
        clauses.push("advisor_identity_user_id IS NOT NULL");
      } else if (value.advisor === "unassigned") {
        clauses.push("advisor_identity_user_id IS NULL");
      }
      if (value.status) add("status = ?", value.status);
      if (value.college) add("college_name ILIKE ?", `%${value.college}%`);
      if (value.q) {
        add("(student_reference ILIKE ? OR legal_name ILIKE $QUERY OR preferred_name ILIKE $QUERY OR email ILIKE $QUERY)", `%${value.q}%`);
        clauses[clauses.length - 1] = clauses.at(-1)!.replaceAll("$QUERY", `$${params.length}`);
      }
      params.push(value.limit, (value.page - 1) * value.limit);
      const result = await client.query<StudentListRow>(
        `SELECT student_id, student_reference, legal_name, preferred_name, email,
                current_stage, status, college_name, advisor_identity_user_id,
                count(*) OVER()::int AS total_count
           FROM ${schema}.open_for_australia_students
          WHERE ${clauses.join(" AND ")}
          ORDER BY legal_name ASC, student_id ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        students: result.rows.map((row) => listProjection(row, principal)),
        page: value.page,
        limit: value.limit,
        total: Number(result.rows[0]?.total_count ?? 0),
      };
    });
  }
}

function listProjection(
  row: StudentListRow,
  principal: OpenForAustraliaWorkspacePrincipal,
) {
  const input: Partial<Record<OpenForAustraliaField, unknown>> = {
    studentId: row.student_id,
    studentReference: row.student_reference,
    legalName: row.legal_name,
    preferredName: row.preferred_name,
    email: row.email,
    currentStage: row.current_stage,
    status: row.status,
    collegeName: row.college_name,
    advisorAssigned: row.advisor_identity_user_id !== null,
  };
  const projected = projectOpenForAustraliaFields(input, principal.role, {
    surface: "list",
    assigned: principal.role === "advisor",
  });
  return { ...projected.values, maskedFields: projected.maskedFields };
}

function runtimeSchema(): string {
  const schema = process.env.SOPHIA_RUNTIME_SCHEMA || "sophia_runtime";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error("SOPHIA_RUNTIME_SCHEMA must be a valid PostgreSQL identifier.");
  }
  return schema;
}
