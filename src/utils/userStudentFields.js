export function normalizeStudentNameInXero(value, type, workspaceProfile) {
  if (type !== 'student' || workspaceProfile !== 'student_operations') return null;
  return String(value ?? '').trim() || null;
}
