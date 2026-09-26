# Sophia implementation pointer

For Sophia realtime/control-plane work, read `docs/sophia-realtime-codex-implementation-plan.v2.1.json` and `docs/sophia/implementation-progress.json` first. The architecture JSON is a reported baseline, not implementation evidence.

Protect the real-estate demo with deterministic tests. Keep student-agency code out of new v2 core/capability/Admin roots until its disposition is approved. Do not hardcode AI vendors in core; use explicit provider adapter/capability boundaries. Do not invoke live providers, email, billing, subscriptions, production migrations, or production data unless the task explicitly authorizes them. Update the progress checkpoint with commands actually run and honest blockers.

Database migrations use the configured owner connection. Normal Sophia Runtime connections must assume the non-`BYPASSRLS` `sophia_runtime_app` role as documented in `docs/sophia/database-role-hardening.md`; do not disable this boundary.
