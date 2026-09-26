export const ADMIN_PERMISSIONS = [
  "platform.organisations.provision",
  "platform.support.access",
  "organisation.read", "organisation.manage", "organisation.suspend",
  "users.read", "users.invite", "users.manage", "users.roles.assign",
  "agents.read", "agents.edit", "agents.publish", "agents.disable",
  "agent_versions.read", "agent_versions.publish", "agent_versions.rollback",
  "instructions.read", "instructions.edit", "instructions.test",
  "knowledge.read", "knowledge.edit", "knowledge.ingest", "knowledge.publish", "knowledge.retire",
  "tools.read", "tools.bind", "tools.test",
  "connectors.read", "connectors.manage", "connectors.test", "connectors.credentials.rotate",
  "workflows.read", "workflows.configure", "workflows.publish", "workflows.retry",
  "permissions.read", "permissions.assign",
  "escalations.read", "escalations.configure", "escalations.assign", "escalations.resolve",
  "conversations.read_metadata", "conversations.read_content", "conversations.export", "conversations.annotate",
  "evaluations.read", "evaluations.edit", "evaluations.run", "evaluations.approve",
  "analytics.read", "analytics.export",
  "audit.read", "audit.export",
  "privacy.read", "privacy.manage", "privacy.approve", "privacy.requests.manage", "privacy.holds.manage",
  "usage.read", "usage.limits.manage", "billing.read", "billing.manage",
] as const;

export type AdminPermission = typeof ADMIN_PERMISSIONS[number];
export type AdminRoleKey = keyof typeof ADMIN_ROLE_PERMISSIONS;

const CONFIGURATION_READ = [
  "organisation.read", "agents.read", "agent_versions.read", "instructions.read",
  "knowledge.read", "tools.read", "connectors.read", "workflows.read",
  "escalations.read",
] as const satisfies readonly AdminPermission[];

export const ADMIN_ROLE_PERMISSIONS = {
  organisation_owner: [
    ...CONFIGURATION_READ,
    "organisation.manage", "organisation.suspend",
    "users.read", "users.invite", "users.manage", "users.roles.assign",
    "permissions.read", "permissions.assign", "analytics.read", "analytics.export", "audit.read", "audit.export",
    "privacy.read", "privacy.manage", "privacy.approve", "privacy.requests.manage", "privacy.holds.manage",
    "usage.read", "billing.read",
  ],
  configuration_editor: [
    ...CONFIGURATION_READ,
    "agents.edit", "instructions.edit", "instructions.test",
    "knowledge.edit", "knowledge.ingest", "tools.bind", "tools.test",
    "connectors.manage", "connectors.test", "workflows.configure", "escalations.configure",
    "evaluations.read", "evaluations.edit", "evaluations.run",
  ],
  release_publisher: [
    ...CONFIGURATION_READ,
    "agents.publish", "agent_versions.publish", "agent_versions.rollback",
    "knowledge.publish", "knowledge.retire", "workflows.publish",
    "evaluations.read", "evaluations.run", "evaluations.approve",
  ],
  operations_member: [
    "organisation.read", "agents.read", "escalations.read", "escalations.assign",
    "escalations.resolve", "conversations.read_metadata", "conversations.annotate",
    "analytics.read", "usage.read",
  ],
  billing_administrator: ["organisation.read", "usage.read", "usage.limits.manage", "billing.read", "billing.manage"],
  read_only_auditor: [
    "organisation.read", "agents.read", "agent_versions.read", "instructions.read",
    "knowledge.read", "tools.read", "connectors.read", "workflows.read",
    "permissions.read", "conversations.read_metadata", "analytics.read", "audit.read", "privacy.read", "usage.read", "billing.read",
  ],
} as const satisfies Record<string, readonly AdminPermission[]>;

export const MFA_REQUIRED_PERMISSIONS = new Set<AdminPermission>([
  "platform.organisations.provision",
  "platform.support.access",
  "organisation.suspend",
  "agents.disable",
  "users.roles.assign",
  "permissions.assign",
  "connectors.credentials.rotate",
  "conversations.read_content",
  "conversations.export",
  "audit.export",
  "privacy.approve",
  "privacy.requests.manage",
  "privacy.holds.manage",
  "usage.limits.manage",
  "billing.manage",
]);

const permissionSet = new Set<string>(ADMIN_PERMISSIONS);

export function isAdminPermission(value: string): value is AdminPermission {
  return permissionSet.has(value);
}

export function isAdminRoleKey(value: string): value is AdminRoleKey {
  return Object.hasOwn(ADMIN_ROLE_PERMISSIONS, value);
}
