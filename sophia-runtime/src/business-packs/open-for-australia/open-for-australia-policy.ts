export const OPEN_FOR_AUSTRALIA_POLICY_VERSION = "2026-10-05.1";

export const OPEN_FOR_AUSTRALIA_PERMISSIONS = [
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
] as const;

export type OpenForAustraliaPermission =
  typeof OPEN_FOR_AUSTRALIA_PERMISSIONS[number];

export const OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS = {
  chief_executive: OPEN_FOR_AUSTRALIA_PERMISSIONS,
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
} as const satisfies Record<string, readonly OpenForAustraliaPermission[]>;

export const OPEN_FOR_AUSTRALIA_STEP_UP_PERMISSIONS = [
  "payments.approve",
  "reports.export",
  "privacy.manage",
] as const satisfies readonly OpenForAustraliaPermission[];

export type OpenForAustraliaRole =
  keyof typeof OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS;

export type OpenForAustraliaFieldClassification =
  | "operational"
  | "personal"
  | "restricted_personal"
  | "restricted_identity"
  | "sensitive_information"
  | "restricted_financial";

type FieldPolicy = {
  classification: OpenForAustraliaFieldClassification;
  listVisible: boolean;
  permission: "student" | "identity" | "sensitive" | "payment_status" | "payment_full";
};

export const OPEN_FOR_AUSTRALIA_FIELD_POLICIES = {
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

export type OpenForAustraliaField =
  keyof typeof OPEN_FOR_AUSTRALIA_FIELD_POLICIES;

export type OpenForAustraliaAccessContext = {
  surface: "list" | "case";
  assigned: boolean;
};

export type OpenForAustraliaFieldProjection = {
  values: Partial<Record<OpenForAustraliaField, unknown>>;
  maskedFields: OpenForAustraliaField[];
};

export function projectOpenForAustraliaFields(
  input: Partial<Record<OpenForAustraliaField, unknown>>,
  role: OpenForAustraliaRole,
  context: OpenForAustraliaAccessContext,
): OpenForAustraliaFieldProjection {
  const permissions = new Set<OpenForAustraliaPermission>(
    OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS[role],
  );
  const values: Partial<Record<OpenForAustraliaField, unknown>> = {};
  const maskedFields: OpenForAustraliaField[] = [];

  for (const field of Object.keys(OPEN_FOR_AUSTRALIA_FIELD_POLICIES) as OpenForAustraliaField[]) {
    if (!Object.hasOwn(input, field)) continue;
    const policy = OPEN_FOR_AUSTRALIA_FIELD_POLICIES[field];
    const allowed = policy.listVisible || context.surface === "case"
      ? hasFieldPermission(permissions, policy.permission, context.assigned)
      : false;
    if (allowed) values[field] = input[field];
    else maskedFields.push(field);
  }
  return { values, maskedFields };
}

export const OPEN_FOR_AUSTRALIA_DATA_FLOWS = [
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

export const OPEN_FOR_AUSTRALIA_PRIVACY_TARGETS = [
  "student_profiles",
  "student_cases_and_activity",
  "student_documents",
  "payment_control_records",
  "access_and_decision_audit",
] as const;

export const OPEN_FOR_AUSTRALIA_RETENTION_TARGETS =
  OPEN_FOR_AUSTRALIA_PRIVACY_TARGETS.map((datasetKey) => ({
    datasetKey,
    retentionDays: null,
    legalReviewRequired: true,
    legalHoldAware: true,
    automaticDeletionEnabled: false,
    disposalMethod: "unapproved",
  } as const));

export function hasOpenForAustraliaPermission(
  role: OpenForAustraliaRole,
  permission: OpenForAustraliaPermission,
): boolean {
  return (OPEN_FOR_AUSTRALIA_ROLE_PERMISSIONS[role] as readonly OpenForAustraliaPermission[])
    .includes(permission);
}

function hasFieldPermission(
  permissions: ReadonlySet<OpenForAustraliaPermission>,
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
