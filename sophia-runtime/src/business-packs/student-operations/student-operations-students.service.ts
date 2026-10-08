import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DatabaseService } from "../../database/database.service.js";
import {
  hasStudentOperationsPermission,
  projectStudentOperationsFields,
  type StudentOperationsField,
} from "./student-operations-policy.js";
import type { StudentOperationsWorkspacePrincipal } from "./student-operations-workspace.service.js";

const StudentStatusSchema = z.enum([
  "active",
  "action_required",
  "on_hold",
  "completed",
  "archived",
]);

const StudentStageSchema = z.enum([
  "new_application",
  "pre_payment_audit",
  "student_payment_received",
  "reconciliation",
  "cover_letter",
  "college_payment",
  "collections",
  "commission_recovery",
  "completed",
]);

const NullableShortTextSchema = z.union([
  z.string().trim().min(1).max(200),
  z.literal(""),
  z.null(),
]).transform((value) => value || null);

const StudentWriteSchema = z.object({
  studentReference: z.string().trim().min(1).max(80)
    .regex(/^[A-Za-z0-9._\/-]+$/, "Use letters, numbers, dots, slashes, underscores or hyphens."),
  legalName: z.string().trim().min(1).max(200),
  preferredName: NullableShortTextSchema,
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  currentStage: StudentStageSchema,
  status: StudentStatusSchema,
  advisorIdentityUserId: z.union([z.string().uuid(), z.literal(""), z.null()])
    .transform((value) => value || null),
  collegeName: NullableShortTextSchema,
}).strict();

const StudentUpdateSchema = StudentWriteSchema.extend({
  recordVersion: z.number().int().positive(),
}).strict();

const StudentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  status: StudentStatusSchema.optional(),
  advisor: z.enum(["assigned", "unassigned", "me"]).optional(),
  advisorIdentityUserId: z.string().trim().min(1).max(200).optional(),
  college: z.string().trim().min(1).max(160).optional(),
}).strict();

const StudentIdSchema = z.string().uuid();
const IdempotencyKeySchema = z.string().trim().min(8).max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);

type StudentWrite = z.infer<typeof StudentWriteSchema>;
type StudentUpdate = z.infer<typeof StudentUpdateSchema>;

type StudentRow = {
  student_id: string;
  student_reference: string;
  legal_name: string;
  preferred_name: string | null;
  email: string;
  current_stage: string;
  status: string;
  college_name: string | null;
  advisor_identity_user_id: string | null;
  record_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  total_count?: number;
};

type StoredWriteRequest = {
  operation: string;
  request_fingerprint: string;
  response: Record<string, unknown> | null;
};

@Injectable()
export class StudentOperationsStudentsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(principal: StudentOperationsWorkspacePrincipal, input: unknown) {
    const value = parse(StudentListQuerySchema, input, "Invalid student list query.");
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
        add(
          "(student_reference ILIKE ? OR legal_name ILIKE $QUERY OR preferred_name ILIKE $QUERY OR email ILIKE $QUERY)",
          `%${value.q}%`,
        );
        clauses[clauses.length - 1] = clauses.at(-1)!.replaceAll("$QUERY", `$${params.length}`);
      }
      params.push(value.limit, (value.page - 1) * value.limit);
      const result = await client.query<StudentRow>(
        `SELECT student_id, student_reference, legal_name, preferred_name, email,
                current_stage, status, college_name, advisor_identity_user_id,
                record_version, created_at, updated_at,
                count(*) OVER()::int AS total_count
           FROM ${schema}.student_operations_students
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

  async get(principal: StudentOperationsWorkspacePrincipal, studentIdInput: string) {
    const studentId = parse(StudentIdSchema, studentIdInput, "Invalid student identifier.");
    const schema = runtimeSchema();
    return this.database.tenantReadTransaction(principal.tenantId, async (client) => {
      const params: unknown[] = [principal.tenantId, studentId];
      const advisorScope = principal.role === "advisor"
        ? " AND advisor_identity_user_id = $3"
        : "";
      if (principal.role === "advisor") params.push(principal.identityUserId);
      const result = await client.query<StudentRow>(
        `SELECT student_id, student_reference, legal_name, preferred_name, email,
                current_stage, status, college_name, advisor_identity_user_id,
                record_version, created_at, updated_at
           FROM ${schema}.student_operations_students
          WHERE customer_id = $1 AND student_id = $2${advisorScope}`,
        params,
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Student not found.");
      return detailProjection(row, principal);
    });
  }

  async advisors(principal: StudentOperationsWorkspacePrincipal) {
    assertManage(principal);
    const schema = runtimeSchema();
    return this.database.tenantReadTransaction(principal.tenantId, async (client) => {
      const result = await client.query<{ identity_user_id: string }>(
        `SELECT identity_user_id
           FROM ${schema}.business_pack_entitlements
          WHERE customer_id = $1
            AND pack_id = 'student-operations'
            AND status = 'active'
            AND role = 'advisor'
          ORDER BY identity_user_id`,
        [principal.tenantId],
      );
      return { advisorIdentityUserIds: result.rows.map((row) => row.identity_user_id) };
    });
  }

  async create(
    principal: StudentOperationsWorkspacePrincipal,
    input: unknown,
    idempotencyKeyInput?: string,
    correlationId: string = randomUUID(),
  ) {
    assertManage(principal);
    const value = parse(StudentWriteSchema, input, "Invalid student details.");
    const idempotencyKey = parse(
      IdempotencyKeySchema,
      idempotencyKeyInput,
      "A valid Idempotency-Key header is required.",
    );
    const operation = "student.create";
    const fingerprint = requestFingerprint(operation, value);
    const schema = runtimeSchema();
    return this.database.tenantTransaction(principal.tenantId, async (client) => {
      const replay = await reserveWrite(
        client, schema, principal, idempotencyKey, operation, fingerprint,
      );
      if (replay) return replayStudent(client, schema, principal, replay);
      await validateAdvisor(client, schema, principal.tenantId, value.advisorIdentityUserId);
      const studentId = randomUUID();
      const result = await client.query<StudentRow>(
        `INSERT INTO ${schema}.student_operations_students
           (student_id, customer_id, student_reference, legal_name, preferred_name,
            email, current_stage, status, advisor_identity_user_id, college_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (customer_id, student_reference) DO NOTHING
         RETURNING student_id, student_reference, legal_name, preferred_name, email,
                   current_stage, status, college_name, advisor_identity_user_id,
                   record_version, created_at, updated_at`,
        [studentId, principal.tenantId, ...writeValues(value)],
      );
      const row = result.rows[0];
      if (!row) throw new ConflictException("A student with this reference already exists.");
      const response = detailProjection(row, principal);
      await appendAudit(client, schema, principal, row, "student.created", writeFieldNames(), correlationId);
      await completeWrite(client, schema, principal, idempotencyKey, row);
      return response;
    });
  }

  async update(
    principal: StudentOperationsWorkspacePrincipal,
    studentIdInput: string,
    input: unknown,
    idempotencyKeyInput?: string,
    correlationId: string = randomUUID(),
  ) {
    assertManage(principal);
    const studentId = parse(StudentIdSchema, studentIdInput, "Invalid student identifier.");
    const value = parse(StudentUpdateSchema, input, "Invalid student details.");
    const idempotencyKey = parse(
      IdempotencyKeySchema,
      idempotencyKeyInput,
      "A valid Idempotency-Key header is required.",
    );
    const operation = "student.update";
    const fingerprint = requestFingerprint(operation, { studentId, ...value });
    const schema = runtimeSchema();
    return this.database.tenantTransaction(principal.tenantId, async (client) => {
      const replay = await reserveWrite(
        client, schema, principal, idempotencyKey, operation, fingerprint,
      );
      if (replay) return replayStudent(client, schema, principal, replay);
      const currentResult = await client.query<StudentRow>(
        `SELECT student_id, student_reference, legal_name, preferred_name, email,
                current_stage, status, college_name, advisor_identity_user_id,
                record_version, created_at, updated_at
           FROM ${schema}.student_operations_students
          WHERE customer_id = $1 AND student_id = $2
          FOR UPDATE`,
        [principal.tenantId, studentId],
      );
      const current = currentResult.rows[0];
      if (!current) throw new NotFoundException("Student not found.");
      if (current.record_version !== value.recordVersion) {
        throw new ConflictException("This student was changed by another user. Reload and try again.");
      }
      await validateAdvisor(client, schema, principal.tenantId, value.advisorIdentityUserId);
      const changedFields = changedFieldNames(current, value);
      if (changedFields.length === 0) {
        const response = detailProjection(current, principal);
        await completeWrite(client, schema, principal, idempotencyKey, current);
        return response;
      }
      let result;
      try {
        result = await client.query<StudentRow>(
          `UPDATE ${schema}.student_operations_students
            SET student_reference = $3,
                legal_name = $4,
                preferred_name = $5,
                email = $6,
                current_stage = $7,
                status = $8,
                advisor_identity_user_id = $9,
                college_name = $10,
                record_version = record_version + 1,
                updated_at = now()
          WHERE customer_id = $1 AND student_id = $2 AND record_version = $11
          RETURNING student_id, student_reference, legal_name, preferred_name, email,
                    current_stage, status, college_name, advisor_identity_user_id,
                    record_version, created_at, updated_at`,
          [principal.tenantId, studentId, ...writeValues(value), value.recordVersion],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ConflictException("A student with this reference already exists.");
        }
        throw error;
      }
      const row = result.rows[0];
      if (!row) {
        throw new ConflictException("This student was changed by another user. Reload and try again.");
      }
      const response = detailProjection(row, principal);
      await appendAudit(client, schema, principal, row, "student.updated", changedFields, correlationId);
      await completeWrite(client, schema, principal, idempotencyKey, row);
      return response;
    });
  }

  async summary(principal: StudentOperationsWorkspacePrincipal) {
    const schema = runtimeSchema();
    return this.database.tenantReadTransaction(principal.tenantId, async (client) => {
      const params: unknown[] = [principal.tenantId];
      const advisorScope = principal.role === "advisor"
        ? " AND advisor_identity_user_id = $2"
        : "";
      if (principal.role === "advisor") params.push(principal.identityUserId);
      const result = await client.query<{
        total: number;
        active: number;
        action_required: number;
        on_hold: number;
      }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'active')::int AS active,
                count(*) FILTER (WHERE status = 'action_required')::int AS action_required,
                count(*) FILTER (WHERE status = 'on_hold')::int AS on_hold
           FROM ${schema}.student_operations_students
          WHERE customer_id = $1${advisorScope}`,
        params,
      );
      const row = result.rows[0];
      return {
        totalStudents: Number(row?.total ?? 0),
        activeStudents: Number(row?.active ?? 0),
        actionRequired: Number(row?.action_required ?? 0),
        onHold: Number(row?.on_hold ?? 0),
      };
    });
  }
}

function assertManage(principal: StudentOperationsWorkspacePrincipal): void {
  if (!hasStudentOperationsPermission(principal.role, "students.manage")) {
    throw new ForbiddenException("This role cannot create or edit students.");
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException({
      message,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function writeValues(value: StudentWrite): unknown[] {
  return [
    value.studentReference,
    value.legalName,
    value.preferredName,
    value.email,
    value.currentStage,
    value.status,
    value.advisorIdentityUserId,
    value.collegeName,
  ];
}

function writeFieldNames(): StudentOperationsField[] {
  return [
    "studentReference",
    "legalName",
    "preferredName",
    "email",
    "currentStage",
    "status",
    "advisorIdentityUserId",
    "collegeName",
  ];
}

function changedFieldNames(current: StudentRow, value: StudentUpdate): StudentOperationsField[] {
  const comparisons: Array<[StudentOperationsField, unknown, unknown]> = [
    ["studentReference", current.student_reference, value.studentReference],
    ["legalName", current.legal_name, value.legalName],
    ["preferredName", current.preferred_name, value.preferredName],
    ["email", current.email, value.email],
    ["currentStage", current.current_stage, value.currentStage],
    ["status", current.status, value.status],
    ["advisorIdentityUserId", current.advisor_identity_user_id, value.advisorIdentityUserId],
    ["collegeName", current.college_name, value.collegeName],
  ];
  return comparisons.filter(([, before, after]) => before !== after).map(([field]) => field);
}

function requestFingerprint(operation: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify({ operation, value })).digest("hex");
}

async function reserveWrite(
  client: PoolClient,
  schema: string,
  principal: StudentOperationsWorkspacePrincipal,
  idempotencyKey: string,
  operation: string,
  fingerprint: string,
): Promise<Record<string, unknown> | null> {
  const inserted = await client.query(
    `INSERT INTO ${schema}.student_operations_write_requests
       (customer_id, actor_identity_user_id, idempotency_key, operation, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING idempotency_key`,
    [principal.tenantId, principal.identityUserId, idempotencyKey, operation, fingerprint],
  );
  if (inserted.rowCount === 1) return null;
  const existing = await client.query<StoredWriteRequest>(
    `SELECT operation, request_fingerprint, response
       FROM ${schema}.student_operations_write_requests
      WHERE customer_id = $1 AND actor_identity_user_id = $2 AND idempotency_key = $3
      FOR UPDATE`,
    [principal.tenantId, principal.identityUserId, idempotencyKey],
  );
  const request = existing.rows[0];
  if (!request || request.operation !== operation || request.request_fingerprint !== fingerprint) {
    throw new ConflictException("This Idempotency-Key was already used for a different request.");
  }
  if (!request.response) {
    throw new ConflictException("The original request is still being processed. Try again shortly.");
  }
  return { ...request.response, idempotentReplay: true };
}

async function completeWrite(
  client: PoolClient,
  schema: string,
  principal: StudentOperationsWorkspacePrincipal,
  idempotencyKey: string,
  row: StudentRow,
): Promise<void> {
  const responseMetadata = {
    studentId: row.student_id,
    recordVersion: row.record_version,
  };
  await client.query(
    `UPDATE ${schema}.student_operations_write_requests
        SET student_id = $4, response = $5::jsonb
      WHERE customer_id = $1 AND actor_identity_user_id = $2 AND idempotency_key = $3`,
    [
      principal.tenantId,
      principal.identityUserId,
      idempotencyKey,
      row.student_id,
      JSON.stringify(responseMetadata),
    ],
  );
}

async function replayStudent(
  client: PoolClient,
  schema: string,
  principal: StudentOperationsWorkspacePrincipal,
  responseMetadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const studentId = responseMetadata.studentId;
  if (typeof studentId !== "string") {
    throw new ConflictException("The stored idempotent response is incomplete. Use a new request key.");
  }
  const result = await client.query<StudentRow>(
    `SELECT student_id, student_reference, legal_name, preferred_name, email,
            current_stage, status, college_name, advisor_identity_user_id,
            record_version, created_at, updated_at
       FROM ${schema}.student_operations_students
      WHERE customer_id = $1 AND student_id = $2`,
    [principal.tenantId, studentId],
  );
  const row = result.rows[0];
  if (!row) throw new ConflictException("The original student record is no longer available.");
  return { ...detailProjection(row, principal), idempotentReplay: true };
}

async function validateAdvisor(
  client: PoolClient,
  schema: string,
  tenantId: string,
  advisorIdentityUserId: string | null,
): Promise<void> {
  if (!advisorIdentityUserId) return;
  const result = await client.query(
    `SELECT 1
       FROM ${schema}.business_pack_entitlements
      WHERE customer_id = $1
        AND identity_user_id = $2
        AND pack_id = 'student-operations'
        AND status = 'active'
        AND role = 'advisor'`,
    [tenantId, advisorIdentityUserId],
  );
  if (result.rowCount !== 1) {
    throw new BadRequestException("The selected user is not an active Student Operations advisor.");
  }
}

async function appendAudit(
  client: PoolClient,
  schema: string,
  principal: StudentOperationsWorkspacePrincipal,
  row: StudentRow,
  eventType: "student.created" | "student.updated",
  changedFields: StudentOperationsField[],
  correlationId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ${schema}.student_operations_student_audit_events
       (customer_id, student_id, actor_identity_user_id, event_type,
        record_version, changed_fields, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      principal.tenantId,
      row.student_id,
      principal.identityUserId,
      eventType,
      row.record_version,
      changedFields,
      correlationId,
    ],
  );
}

function listProjection(row: StudentRow, principal: StudentOperationsWorkspacePrincipal) {
  const input: Partial<Record<StudentOperationsField, unknown>> = {
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
  const projected = projectStudentOperationsFields(input, principal.role, {
    surface: "list",
    assigned: principal.role === "advisor",
  });
  return { ...projected.values, maskedFields: projected.maskedFields };
}

function detailProjection(row: StudentRow, principal: StudentOperationsWorkspacePrincipal) {
  const assigned = row.advisor_identity_user_id === principal.identityUserId;
  const input: Partial<Record<StudentOperationsField, unknown>> = {
    studentId: row.student_id,
    studentReference: row.student_reference,
    legalName: row.legal_name,
    preferredName: row.preferred_name,
    email: row.email,
    currentStage: row.current_stage,
    status: row.status,
    collegeName: row.college_name,
    advisorAssigned: row.advisor_identity_user_id !== null,
    advisorIdentityUserId: row.advisor_identity_user_id,
    recordVersion: row.record_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const projected = projectStudentOperationsFields(input, principal.role, {
    surface: "case",
    assigned,
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
