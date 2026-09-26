# Real-estate characterization at P0

These tests freeze observed behavior; they do not certify live providers or redesign the flow.

| Journey | Deterministic evidence | P0 result / limitation |
|---|---|---|
| RE-01 sale/rent search, details, photos | `tests/sophia.realEstate.characterization.test.js`; existing runtime real-estate tool tests | Root fixtures preserve authoritative values, listing type, photos, and missing optional fields. Runtime tests are separately recorded in the checkpoint. |
| RE-02 slots, review, explicit confirmation | Capacity-one and multi-capacity fixtures; `bm.realEstateConfirmation.test.js`; runtime `real-estate.tools.spec.ts` | Explicit review/confirmation and authoritative slot labels characterized. No live browser speech test. |
| RE-03 rental commit and confirmation without report | Fixture plus `bm.realEstateBookingQueue.test.js`, `bm.inspectionWorkflow.test.js`, runtime Business Manager client tests | Rental stays out of the property-report queue. Email/provider calls are mocked. |
| RE-04 sale commit, async report and email | Sale delivery states plus report job/worker and inspection email worker tests | Booking commit and queued report lifecycle characterized with mocks. No email sent. |
| RE-05 corrected email review/resend | `bm.realEstateConfirmation.test.js` and runtime Business Manager client tests | Review-before-resend behavior characterized. No external delivery. |
| RE-06 approved agency knowledge, no invention | Existing real-estate knowledge/tool tests and source inspection | Current fallback behavior is characterized but does not fully satisfy the target: a hardcoded fallback remains. Treat as an explicit migration risk, not a pass for the final architecture. |
| RE-07 three supported experience compositions | Runtime provider/session specs and Angular static mapping | Composition creation is mock/static evidence only. Live OpenAI/avatar providers were forbidden in P0, so latency, media, and live interoperability remain unrun. |

Fixtures cover sale, rental, missing optional fields, capacity one, multi-capacity, rental delivery, and sale report/delivery states. They contain no production IDs, credentials, or network calls.

The RE-06 approved-source gap belongs to the P3 knowledge/real-estate-pack work; it must not be hidden by retaining fallback assertions. RE-07 live composition/media proof belongs to the later provider validation and release-evidence phase. The current mock tests protect configuration contracts only.
