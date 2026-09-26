# P0 architecture decisions

The following records adopt the target decisions while documenting current evidence gaps.

| ADR | Decision | P0 evidence / discrepancy |
|---|---|---|
| ADR-01 | Keep NestJS, Angular, and Express; no rewrite | All three are active deployable concerns. Boundaries need tightening, not a port. |
| ADR-02 | Separate ReasoningProvider from native realtime, speech, and avatar | Current provider/session branches mix vendor and experience concerns. No neutral ports exist yet. |
| ADR-03 | Compose providers by explicit capabilities | Angular/runtime still contain OpenAI/Tavus/avatar-specific selection. |
| ADR-04 | Use versioned server profiles; browser requests an allowed experience | `ai_configs` exists, but no immutable published profile is resolved for session creation. |
| ADR-05 | Persist generic action reviews and authoritative receipts | Reviews are in-memory; Business Manager booking transactions are authoritative receipts. |
| ADR-06 | Reuse report/email queues | PostgreSQL inspection report and delivery workers are source-verified assets with characterization tests. |
| ADR-07 | Core exposes capabilities, not industries | Legacy code mixes property and student domains. New boundary checks reserve neutral roots. |
| ADR-08 | Use schema-validated pack extensions; avoid EAV/unrestricted JSON | Proposed only; current domain tables remain. Do not redesign them in P0. |
| ADR-09 | Use explicit adapters/compiled packs; no executable plugins | Current tools are compiled. A neutral registration boundary is absent. |
| ADR-10 | Canonical conversation state plus isolated provider session | Current session/tool records are partial and provider/browser state is mixed. |
| ADR-11 | No automatic cross-provider failover during pending mutations | No safe durable handoff was verified; preserve this prohibition. |
| ADR-12 | Security/privacy gates precede real tenant use; infrastructure relocation is separate | Current RBAC, content access, audit, and retention controls are insufficient for Admin activation. |

These decisions do not assert that the proposed architecture is implemented.
