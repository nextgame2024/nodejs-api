// Only fixed categories may reach logs: provider/SQL messages can contain
// credentials, customer content, queries and remote response bodies.
const codes = new Set([
  "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "INCOMPLETE_RESPONSE",
  "INVALID_PROVIDER_EVENT", "INVALID_CHANNEL_CREDENTIAL", "INVALID_CHANNEL_ADAPTER",
  "CHANNEL_OUTPUT_LIMIT", "UNEXPECTED_TOOL_CALL",
]);
const databaseCodes = {
  "28P01": "database_authentication_failed",
  "42501": "database_permission_denied",
  "42P01": "database_table_missing",
  "42703": "database_column_missing",
  "53300": "database_connection_limit",
  "57014": "database_query_cancelled",
};
export function workerFailureCode(error) {
  if (codes.has(error?.code)) return error.code.toLowerCase();
  if (Object.hasOwn(databaseCodes, error?.code ?? "")) return databaseCodes[error.code];
  if (error?.name === "TimeoutError") return "generation_timeout";
  if (error?.name === "AbortError") return "operation_aborted";
  if (error instanceof SyntaxError) return "invalid_answer_json";
  return "operation_failed";
}
