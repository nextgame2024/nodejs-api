export const STUDENT_OPERATIONS_POLICY_VERSION = "2026-10-09.1";

export const STUDENT_OPERATIONS_PERMISSIONS = [
  "workspace.read",
  "students.read_all",
  "students.read_assigned",
  "students.manage",
  "students.identity.read_all",
  "students.identity.read_assigned",
  "students.sensitive.read_all",
  "students.sensitive.read_assigned",
  "cases.read_all",
  "cases.read_assigned",
  "cases.manage",
  "documents.metadata.read_all",
  "documents.metadata.read_assigned",
  "documents.content.read_all",
  "documents.content.read_assigned",
  "payments.read_all",
  "payments.read_assigned_status",
  "payments.prepare",
  "payments.approve",
  "reports.export",
  "assistant.use",
  "privacy.manage",
  "integrations.manage",
] as const;

export type StudentOperationsPermission =
  typeof STUDENT_OPERATIONS_PERMISSIONS[number];

export const STUDENT_OPERATIONS_ROLE_PERMISSIONS = {
  chief_executive: STUDENT_OPERATIONS_PERMISSIONS,
  operations: [
    "workspace.read",
    "students.read_all",
    "students.manage",
    "students.identity.read_all",
    "students.sensitive.read_all",
    "cases.read_all",
    "cases.manage",
    "documents.metadata.read_all",
    "documents.content.read_all",
    "payments.read_all",
    "payments.prepare",
    "assistant.use",
  ],
  advisor: [
    "workspace.read",
    "students.read_assigned",
    "students.identity.read_assigned",
    "students.sensitive.read_assigned",
    "cases.read_assigned",
    "documents.metadata.read_assigned",
    "documents.content.read_assigned",
    "payments.read_assigned_status",
    "assistant.use",
  ],
} as const satisfies Record<string, readonly StudentOperationsPermission[]>;

export const STUDENT_OPERATIONS_STEP_UP_PERMISSIONS = [
  "payments.approve",
  "reports.export",
  "privacy.manage",
] as const satisfies readonly StudentOperationsPermission[];

export type StudentOperationsRole =
  keyof typeof STUDENT_OPERATIONS_ROLE_PERMISSIONS;

export type StudentOperationsFieldClassification =
  | "operational"
  | "personal"
  | "restricted_personal"
  | "restricted_identity"
  | "sensitive_information"
  | "restricted_financial";

type FieldPolicy = {
  classification: StudentOperationsFieldClassification;
  listVisible: boolean;
  permission: "student" | "identity" | "sensitive" | "payment_status" | "payment_full";
};

export const STUDENT_OPERATIONS_FIELD_POLICIES = {
  studentId: {
    classification: "operational", listVisible: true, permission: "student",
  },
  studentReference: {
    classification: "operational", listVisible: true, permission: "student",
  },
  legalName: {
    classification: "personal", listVisible: true, permission: "student",
  },
  preferredName: {
    classification: "personal", listVisible: true, permission: "student",
  },
  email: {
    classification: "personal", listVisible: true, permission: "student",
  },
  currentStage: {
    classification: "operational", listVisible: true, permission: "student",
  },
  status: {
    classification: "operational", listVisible: true, permission: "student",
  },
  collegeName: {
    classification: "personal", listVisible: true, permission: "student",
  },
  advisorAssigned: {
    classification: "operational", listVisible: true, permission: "student",
  },
  advisorIdentityUserId: {
    classification: "operational", listVisible: false, permission: "student",
  },
  recordVersion: {
    classification: "operational", listVisible: false, permission: "student",
  },
  createdAt: {
    classification: "operational", listVisible: false, permission: "student",
  },
  updatedAt: {
    classification: "operational", listVisible: false, permission: "student",
  },
  phone: {
    classification: "personal", listVisible: false, permission: "student",
  },
  dateOfBirth: {
    classification: "restricted_personal", listVisible: false, permission: "student",
  },
  passportNumber: {
    classification: "restricted_identity", listVisible: false, permission: "identity",
  },
  visaDetails: {
    classification: "restricted_personal", listVisible: false, permission: "identity",
  },
  healthOrCharacterInformation: {
    classification: "sensitive_information", listVisible: false, permission: "sensitive",
  },
  paymentStatus: {
    classification: "restricted_financial", listVisible: false, permission: "payment_status",
  },
  paymentAmount: {
    classification: "restricted_financial", listVisible: false, permission: "payment_full",
  },
  bankReference: {
    classification: "restricted_financial", listVisible: false, permission: "payment_full",
  },
} as const satisfies Record<string, FieldPolicy>;

export type StudentOperationsField =
  keyof typeof STUDENT_OPERATIONS_FIELD_POLICIES;

export type StudentOperationsAccessContext = {
  surface: "list" | "case";
  assigned: boolean;
};

export type StudentOperationsFieldProjection = {
  values: Partial<Record<StudentOperationsField, unknown>>;
  maskedFields: StudentOperationsField[];
};

export function projectStudentOperationsFields(
  input: Partial<Record<StudentOperationsField, unknown>>,
  role: StudentOperationsRole,
  context: StudentOperationsAccessContext,
): StudentOperationsFieldProjection {
  const permissions = new Set<StudentOperationsPermission>(
    STUDENT_OPERATIONS_ROLE_PERMISSIONS[role],
  );
  const values: Partial<Record<StudentOperationsField, unknown>> = {};
  const maskedFields: StudentOperationsField[] = [];

  for (const field of Object.keys(STUDENT_OPERATIONS_FIELD_POLICIES) as StudentOperationsField[]) {
    if (!Object.hasOwn(input, field)) continue;
    const policy = STUDENT_OPERATIONS_FIELD_POLICIES[field];
    const allowed = policy.listVisible || context.surface === "case"
      ? hasFieldPermission(permissions, policy.permission, context.assigned)
      : false;
    if (allowed) values[field] = input[field];
    else maskedFields.push(field);
  }
  return { values, maskedFields };
}

export const STUDENT_OPERATIONS_DATA_FLOWS = [
  {
    key: "business-manager-to-sophia-runtime",
    capability: "workspace identity and operational API",
    dataCategories: ["account_identifiers", "operational_records"],
    status: "internal_pending_verification",
    processingJurisdictions: [] as string[],
    storageJurisdictions: [] as string[],
    retentionControl: "unverified",
    deletionControl: "unverified",
  },
  {
    key: "student-documents-s3",
    capability: "protected student document storage",
    dataCategories: ["identity_documents", "sensitive_information"],
    status: "not_configured",
    processingJurisdictions: [] as string[],
    storageJurisdictions: [] as string[],
    retentionControl: "unverified",
    deletionControl: "unverified",
  },
  {
    key: "xero-trust-and-pty",
    capability: "read-only accounting synchronization",
    dataCategories: ["payment_records", "accounting_identifiers"],
    status: "not_configured",
    processingJurisdictions: [] as string[],
    storageJurisdictions: [] as string[],
    retentionControl: "unverified",
    deletionControl: "unverified",
  },
  {
    key: "sophia-assistant-provider",
    capability: "grounded operational assistance",
    dataCategories: ["operational_records"],
    status: "not_configured",
    processingJurisdictions: [] as string[],
    storageJurisdictions: [] as string[],
    retentionControl: "unverified",
    deletionControl: "unverified",
  },
] as const;

export const STUDENT_OPERATIONS_PRIVACY_TARGETS = [
  "student_profiles",
  "student_cases_and_activity",
  "student_documents",
  "payment_control_records",
  "access_and_decision_audit",
] as const;

export const STUDENT_OPERATIONS_RETENTION_TARGETS =
  STUDENT_OPERATIONS_PRIVACY_TARGETS.map((datasetKey) => ({
    datasetKey,
    retentionDays: null,
    legalReviewRequired: true,
    legalHoldAware: true,
    automaticDeletionEnabled: false,
    disposalMethod: "unapproved",
  } as const));

export function hasStudentOperationsPermission(
  role: StudentOperationsRole,
  permission: StudentOperationsPermission,
): boolean {
  return (STUDENT_OPERATIONS_ROLE_PERMISSIONS[role] as readonly StudentOperationsPermission[])
    .includes(permission);
}

function hasFieldPermission(
  permissions: ReadonlySet<StudentOperationsPermission>,
  permission: FieldPolicy["permission"],
  assigned: boolean,
): boolean {
  if (permission === "student") {
    return permissions.has("students.read_all")
      || (assigned && permissions.has("students.read_assigned"));
  }
  if (permission === "identity") {
    return permissions.has("students.identity.read_all")
      || (assigned && permissions.has("students.identity.read_assigned"));
  }
  if (permission === "sensitive") {
    return permissions.has("students.sensitive.read_all")
      || (assigned && permissions.has("students.sensitive.read_assigned"));
  }
  if (permission === "payment_status") {
    return permissions.has("payments.read_all")
      || (assigned && permissions.has("payments.read_assigned_status"));
  }
  return permissions.has("payments.read_all");
}
